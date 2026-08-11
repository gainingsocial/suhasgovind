import {
  CompleteConnectionRequestSchema,
  ConnectSessionResponseSchema,
  CreateConnectSessionRequestSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import {
  isProviderName,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_NAMES,
  ProviderNameSchema,
  type ProviderName,
} from '@gs/contracts/providers';
import { decodeSecret, TOKEN_PURPOSE, issueSignedToken, verifySignedToken } from '@gs/crypto';
import {
  completeConnectSession,
  consumeOAuthSession,
  createConnectSession,
  failOAuthSession,
  findConnectSessionById,
  listConnections,
  type ConnectSessionWithProfile,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { hasAdapter } from '@gs/providers';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';
import { providerCallContext } from '../lib/provider-context.js';
import { parseBody } from '../lib/request.js';
import {
  assertAllowedRedirect,
  beginAuthorization,
  completeAuthorization,
  loadOwnedProfile,
  CONNECT_TIMEOUT_MS,
  DESTINATION_TIMEOUT_MS,
} from '../services/connect.js';
import { renderConnectPage } from '../services/connect-page.js';

/**
 * The hosted page names only a platform. Everything else — which profile, which tenant,
 * where the result may go — comes from the session row the token resolves to.
 */
const HostedAuthorizeRequestSchema = z.object({ provider: ProviderNameSchema });

/** The origin providers were told to call back to. Explicit in production (see `Env`). */
function apiOrigin(c: Context<AppEnv>): string {
  return c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin;
}

/**
 * Hosted white-label connect (plan §22).
 *
 * The customer's end user connects their own social accounts on a page that carries the
 * customer's branding, without an account here and without ever seeing this dashboard.
 * For most integrators this replaces building a connect UI at all, which is the single
 * largest piece of work a social-publishing integration would otherwise involve.
 *
 * Authorization is by signed token, not by API key — the person using it has no key and
 * should never be given one. The token is a capability: it names a session, and every
 * decision about what that session may do is re-read from the row it names (P5). It is
 * still a bearer credential, so it is short-lived by default and the page is `noindex`.
 */
export const connectSessions = new Hono<AppEnv>();
export const hostedConnect = new Hono<AppEnv>();

function signingSecret(c: Context<AppEnv>): Uint8Array {
  try {
    return decodeSecret('CONNECT_SESSION_SIGNING_KEY', c.env.CONNECT_SESSION_SIGNING_KEY);
  } catch (cause) {
    // Rule 14 — a missing signing key is a deployment problem, and saying so beats a
    // generic 500 that sends somebody hunting through the connect flow.
    throw new ApiError('INTERNAL_ERROR', {
      message: 'Hosted connect is not configured: CONNECT_SESSION_SIGNING_KEY is missing.',
      cause,
    });
  }
}

/** Platforms that can actually complete a connection today. */
function connectableProviders(): ProviderName[] {
  return PROVIDER_NAMES.filter((provider) => provider !== 'mock' && hasAdapter(provider));
}

connectSessions.post('/', withDatabase(), authenticate(['connections:write']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, CreateConnectSessionRequestSchema);

  const profileId = fromPublicId('profile', body.profile_id);
  if (!profileId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`profile_id` is not a valid profile id.',
      param: 'profile_id',
    });
  }

  const profile = await loadOwnedProfile(
    c.get('db'),
    principal.projectEnvironmentId,
    profileId,
    principal.restrictedToProfileId,
  );

  if (body.return_url) assertAllowedRedirect(body.return_url);
  if (body.branding.logo_url) assertAllowedRedirect(body.branding.logo_url);

  // Offering a platform with no adapter would render a button that cannot work. Filtering
  // silently would hide a typo, so an explicitly requested unavailable provider is an
  // error and an unspecified list defaults to what is genuinely connectable.
  const requested = body.providers ?? connectableProviders();
  for (const provider of requested) {
    if (!hasAdapter(provider)) {
      throw new ApiError('PROVIDER_NOT_SUPPORTED', {
        message: `No adapter is available for "${provider}" yet.`,
        param: 'providers',
      });
    }
  }

  const expiresAt = new Date(Date.now() + body.expires_in * 1000);

  const session = await createConnectSession(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId: profile.id,
    providers: requested,
    branding: body.branding,
    returnUrl: body.return_url ?? null,
    expiresAt,
    createdByApiKeyId: principal.apiKeyId,
  });

  const token = await issueSignedToken({
    secret: signingSecret(c),
    purpose: TOKEN_PURPOSE.connectSession,
    subject: session.id,
    ttlSeconds: body.expires_in,
  });

  const origin = c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin;

  return c.json(
    ConnectSessionResponseSchema.parse({
      object: 'connect_session',
      id: toPublicId('event', session.id),
      profile_id: toPublicId('profile', profile.id),
      providers: requested,
      url: `${origin}/connect/${token}`,
      return_url: session.returnUrl,
      expires_at: session.expiresAt.toISOString(),
      completed_at: null,
      created_at: session.createdAt.toISOString(),
    }),
    201,
  );
});

/**
 * Redeem a connect token.
 *
 * The signature is verified first so no unauthenticated input reaches a database lookup,
 * then the row is re-read and re-checked. A valid signature over an expired or completed
 * session is not enough: the token's own expiry and the row's expiry are separate facts,
 * and the row is the one that counts.
 */
async function redeemToken(
  c: Context<AppEnv>,
  token: string,
): Promise<ConnectSessionWithProfile> {
  const verified = await verifySignedToken({
    secret: signingSecret(c),
    token,
    expectedPurpose: TOKEN_PURPOSE.connectSession,
  });

  if (!verified.valid) throw new ApiError('CONNECT_SESSION_INVALID');

  const session = await findConnectSessionById(c.get('db'), verified.claims.sub);
  if (!session || session.expired) throw new ApiError('CONNECT_SESSION_INVALID');

  return session;
}

/**
 * The hosted page itself.
 *
 * Server-rendered HTML from the API Worker rather than a route in the dashboard app, for
 * three reasons: the page and the endpoints it posts to are same-origin so no CORS
 * configuration stands between a customer's user and connecting; it works whether or not
 * the dashboard is deployed; and it has no client framework to load, which matters on the
 * phone this is most often opened on.
 */
hostedConnect.get('/:token', withDatabase(), async (c) => {
  const session = await redeemToken(c, c.req.param('token'));

  const providers = session.providers.filter(isProviderName);

  const connected = await listConnections(c.get('db'), {
    projectEnvironmentId: session.projectEnvironmentId,
    limit: 100,
    order: 'desc',
    profileId: session.profileId,
    includeDisconnected: false,
  });

  const statusByProvider = new Map(
    connected.rows.map((row) => [
      row.provider,
      {
        accountName: row.providerAccountName ?? row.providerAccountId,
        health: row.health,
        setupComplete: row.setupCompletedAt !== null,
      },
    ]),
  );

  return c.html(
    renderConnectPage({
      token: c.req.param('token'),
      branding: session.branding,
      returnUrl: session.returnUrl,
      providers: providers.map((provider) => ({
        provider,
        displayName: PROVIDER_DISPLAY_NAMES[provider],
        status: statusByProvider.get(provider) ?? null,
      })),
    }),
    200,
    {
      // A connect page is a per-user capability URL. Indexing it, caching it in a shared
      // proxy, or letting it be framed are three different ways to hand it to somebody
      // it was not issued to.
      'cache-control': 'no-store, private',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  );
});

/**
 * Start an authorization from the hosted page.
 *
 * The same handshake `POST /v1/connections/authorize` performs, authorized by the session
 * token instead of an API key. Tenancy comes entirely from the session row — the request
 * body names only which platform to connect, and could not redirect the result elsewhere
 * even if it tried.
 */
hostedConnect.post('/:token/authorize', withDatabase(), async (c) => {
  const trace = c.get('trace');
  const session = await redeemToken(c, c.req.param('token'));
  const body = await parseBody(c, HostedAuthorizeRequestSchema);

  // A session lists the platforms the customer chose to offer. Connecting one they did
  // not offer would be a real escalation: the token would grant more than it was issued
  // for.
  if (!session.providers.includes(body.provider)) {
    throw new ApiError('PROVIDER_NOT_SUPPORTED', {
      message: 'This connect link does not offer that platform.',
      param: 'provider',
    });
  }

  const started = await beginAuthorization({
    db: c.get('db'),
    env: c.env,
    context: providerCallContext(c, { timeoutMs: CONNECT_TIMEOUT_MS }),
    provider: body.provider,
    organizationId: session.organizationId,
    projectId: session.projectId,
    projectEnvironmentId: session.projectEnvironmentId,
    profileId: session.profileId,
    // The user comes back to this page, not to the customer's app: they may still have
    // more accounts to connect, and the "I am finished" button is what ends the session.
    returnUrl: `${apiOrigin(c)}/connect/${c.req.param('token')}`,
    requestedScopes: [],
    options: {},
    apiOrigin: apiOrigin(c),
    connectSessionId: session.id,
    traceId: trace.traceId,
  });

  return c.json(
    {
      object: 'authorization',
      authorization_url: started.authorizationUrl,
      state: started.state,
      completion: started.completion,
      required_credential_fields: started.requiredCredentialFields,
      expires_at: started.expiresAt.toISOString(),
    },
    201,
  );
});

/** Finish a no-consent-screen authorization started from the hosted page. */
hostedConnect.post('/:token/complete', withDatabase(), async (c) => {
  const trace = c.get('trace');
  const session = await redeemToken(c, c.req.param('token'));
  const body = await parseBody(c, CompleteConnectionRequestSchema);

  const oauthSession = await consumeOAuthSession(c.get('db'), body.state);
  if (!oauthSession) throw new ApiError('AUTHORIZATION_SESSION_INVALID');

  // The handshake must belong to *this* connect session. Without this check a token for
  // one session could finish an authorization started under another.
  if (oauthSession.connectSessionId !== session.id) {
    throw new ApiError('AUTHORIZATION_SESSION_INVALID');
  }

  if (!isProviderName(oauthSession.provider)) {
    throw new ApiError('PROVIDER_NOT_SUPPORTED', { param: 'provider' });
  }

  try {
    const result = await completeAuthorization({
      db: c.get('db'),
      env: c.env,
      context: providerCallContext(c, { timeoutMs: DESTINATION_TIMEOUT_MS }),
      provider: oauthSession.provider,
      query: body.credentials,
      organizationId: session.organizationId,
      projectId: session.projectId,
      projectEnvironmentId: session.projectEnvironmentId,
      profileId: session.profileId,
      providerAppId: oauthSession.providerAppId,
      redirectUri: oauthSession.redirectUri,
      traceId: trace.traceId,
    });

    return c.json(
      {
        object: 'connection',
        id: toPublicId('connection', result.connectionId),
        provider: oauthSession.provider,
        setup_complete: result.setupComplete,
      },
      201,
    );
  } catch (error) {
    await failOAuthSession(c.get('db'), oauthSession.id);
    if (error instanceof ApiError) throw error;
    throw new ApiError('AUTHORIZATION_CREDENTIAL_REJECTED', { cause: error });
  }
});

/** Mark a session finished. Called by the page when the user says they are done. */
hostedConnect.post('/:token/finish', withDatabase(), async (c) => {
  const session = await redeemToken(c, c.req.param('token'));
  await completeConnectSession(c.get('db'), session.id);

  return c.json({ object: 'connect_session', completed: true, return_url: session.returnUrl }, 200);
});
