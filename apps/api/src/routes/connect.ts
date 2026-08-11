import {
  AuthorizeConnectionRequestSchema,
  AuthorizeConnectionResponseSchema,
  CompleteConnectionRequestSchema,
  CompleteConnectionResponseSchema,
  DestinationListResponseSchema,
  RefreshConnectionResponseSchema,
  SelectDestinationsRequestSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import { type CREDENTIAL_ALGORITHM } from '@gs/crypto';
import {
  acquireRefreshLock,
  consumeOAuthSession,
  failOAuthSession,
  findConnectionById,
  findConnectionCredentials,
  findProfileById,
  listDestinationsForConnection,
  releaseRefreshLock,
  selectConnectionDestinations,
  setConnectionHealth,
  storeCredential,
  type ConnectionWithScopes,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';
import { providerCallContext } from '../lib/provider-context.js';
import { parseBody, requirePathId } from '../lib/request.js';
import {
  assertAllowedRedirect,
  beginAuthorization,
  callbackUrlFor,
  completeAuthorization,
  loadOwnedProfile,
  requireAdapter,
  CONNECT_TIMEOUT_MS,
  DESTINATION_TIMEOUT_MS,
} from '../services/connect.js';
import { credentialCipher, resolveProviderApp } from '../services/provider-apps.js';
import { toDestinationResponse } from './connection-serializers.js';

/**
 * Connecting an account (plan §21, §22).
 *
 * Mounted in two places because the two halves have genuinely different callers.
 * `/v1/connections/*` is the integrator's API, authenticated with an API key.
 * `/v1/oauth/:provider/callback` is hit by the provider itself — no key, no session, no
 * CORS — and is authorized solely by the `state` it carries. Keeping them in one file
 * keeps the two halves of one handshake readable together.
 */
export const connectRoutes = new Hono<AppEnv>();
export const oauthCallbackRoutes = new Hono<AppEnv>();

/** The origin providers were told to call back to. Explicit in production (see `Env`). */
function apiOrigin(c: Context<AppEnv>): string {
  return c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin;
}

// ---------------------------------------------------------------------------
// Start (plan §21.1)
// ---------------------------------------------------------------------------

connectRoutes.post('/authorize', withDatabase(), authenticate(['connections:write']), async (c) => {
  const principal = c.get('principal');
  const trace = c.get('trace');
  const body = await parseBody(c, AuthorizeConnectionRequestSchema);

  // Checked before the profile lookup so an unbuilt provider fails on the thing that is
  // actually wrong, rather than on a profile that turns out to be fine.
  requireAdapter(body.provider);

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

  // Checked before anything is stored, so a bad return URL fails immediately rather than
  // stranding the user on the provider's consent screen with nowhere to come back to.
  assertAllowedRedirect(body.redirect_url);

  const started = await beginAuthorization({
    db: c.get('db'),
    env: c.env,
    context: providerCallContext(c, { timeoutMs: CONNECT_TIMEOUT_MS }),
    provider: body.provider,
    organizationId: principal.organizationId,
    projectId: principal.projectId,
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId: profile.id,
    returnUrl: body.redirect_url,
    requestedScopes: body.scopes ?? [],
    options: body.state_metadata ?? {},
    apiOrigin: apiOrigin(c),
    traceId: trace.traceId,
  });

  return c.json(
    AuthorizeConnectionResponseSchema.parse({
      object: 'authorization',
      authorization_url: started.authorizationUrl,
      oauth_session_id: toPublicId('event', started.oauthSessionId),
      state: started.state,
      completion: started.completion,
      required_credential_fields: started.requiredCredentialFields,
      expires_at: started.expiresAt.toISOString(),
    }),
    201,
  );
});

// ---------------------------------------------------------------------------
// Finish without a consent screen (plan §20)
// ---------------------------------------------------------------------------

connectRoutes.post('/complete', withDatabase(), authenticate(['connections:write']), async (c) => {
  const principal = c.get('principal');
  const trace = c.get('trace');
  const body = await parseBody(c, CompleteConnectionRequestSchema);

  const session = await consumeOAuthSession(c.get('db'), body.state);
  if (!session) throw new ApiError('AUTHORIZATION_SESSION_INVALID');

  // The session pins the tenant. Comparing it against the presenting key closes the gap
  // where a key from another environment finishes a handshake it did not start (P5).
  if (session.projectEnvironmentId !== principal.projectEnvironmentId) {
    throw new ApiError('AUTHORIZATION_SESSION_INVALID');
  }

  if (!isProviderName(session.provider)) {
    throw new ApiError('PROVIDER_NOT_SUPPORTED', { param: 'provider' });
  }

  try {
    const result = await completeAuthorization({
      db: c.get('db'),
      env: c.env,
      context: providerCallContext(c, { timeoutMs: DESTINATION_TIMEOUT_MS }),
      provider: session.provider,
      query: body.credentials,
      organizationId: principal.organizationId,
      projectId: principal.projectId,
      projectEnvironmentId: session.projectEnvironmentId,
      profileId: session.profileId,
      providerAppId: session.providerAppId,
      redirectUri: session.redirectUri,
      traceId: trace.traceId,
    });

    return c.json(
      CompleteConnectionResponseSchema.parse({
        object: 'connection',
        id: toPublicId('connection', result.connectionId),
        provider: session.provider,
        provider_account_name: result.accountName,
        created: result.created,
        setup_complete: result.setupComplete,
        destination_count: result.destinationCount,
        granted_scopes: result.grantedScopes,
      }),
      201,
    );
  } catch (error) {
    await failOAuthSession(c.get('db'), session.id);
    throw asAuthorizationError(error);
  }
});

/**
 * Present an adapter failure as a credential problem the caller can fix.
 *
 * An `ApiError` already carries a considered code and passes through untouched. Anything
 * else at this point came from the provider rejecting what was supplied — a mistyped app
 * password is the overwhelming case — and reporting that as a 500 sends the user to
 * support for a typo.
 */
function asAuthorizationError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  return new ApiError('AUTHORIZATION_CREDENTIAL_REJECTED', { cause: error });
}

// ---------------------------------------------------------------------------
// Provider callback (plan §21.2)
// ---------------------------------------------------------------------------

/**
 * The redirect target registered with every platform.
 *
 * Unauthenticated by necessity: the caller is a browser following a provider redirect. It
 * is authorized entirely by `state`, which is single-use, expiring, and bound to a tenant
 * at creation. Every tenancy value used below is read from the session row — nothing about
 * where this connection lands comes from the query string.
 *
 * It always ends in a redirect, never a JSON body. The user is in a browser, and a raw
 * error envelope on screen is both alarming and useless to them.
 */
oauthCallbackRoutes.get('/:provider/callback', withDatabase(), async (c) => {
  const trace = c.get('trace');
  const logger = c.get('logger');
  const provider = c.req.param('provider');
  const query = c.req.query();

  const state = query.state;
  if (!state) {
    // Nothing to redirect to and nothing to record: without state there is no session and
    // therefore no return URL. This is the one case that has to render.
    throw new ApiError('AUTHORIZATION_SESSION_INVALID', {
      message: 'The provider callback carried no state parameter.',
    });
  }

  const session = await consumeOAuthSession(c.get('db'), state);
  if (!session) throw new ApiError('AUTHORIZATION_SESSION_INVALID');

  const returnUrl = session.returnUrl;

  /** Hand control back to the customer's app with the outcome in the query string. */
  const back = (params: Record<string, string>): Response => {
    if (!returnUrl) {
      return c.json({ object: 'authorization_result', ...params }, params.error ? 400 : 200);
    }
    const target = new URL(returnUrl);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return c.redirect(target.toString(), 302);
  };

  if (session.provider !== provider || !isProviderName(session.provider)) {
    await failOAuthSession(c.get('db'), session.id);
    return back({ error: 'AUTHORIZATION_SESSION_INVALID' });
  }

  // The provider declined, or the user pressed cancel. Both arrive as an `error`
  // parameter and neither is our failure, so it is reported without a stack trace.
  if (query.error) {
    await failOAuthSession(c.get('db'), session.id);
    logger.info('connect.declined', {
      provider,
      reason: query.error,
      description: query.error_description,
    });
    return back({
      error: 'AUTHORIZATION_FAILED',
      error_detail: query.error_description ?? query.error,
    });
  }

  const profile = await findProfileById(c.get('db'), session.projectEnvironmentId, session.profileId);
  if (!profile) {
    await failOAuthSession(c.get('db'), session.id);
    return back({ error: 'PROFILE_NOT_FOUND' });
  }

  let codeVerifier: string | undefined;
  if (session.encryptedCodeVerifier) {
    codeVerifier = await credentialCipher(c.env).decrypt(
      {
        ciphertext: session.encryptedCodeVerifier.ciphertext,
        nonce: session.encryptedCodeVerifier.nonce,
        algorithm: session.encryptedCodeVerifier.algorithm as typeof CREDENTIAL_ALGORITHM,
        keyVersion: session.encryptedCodeVerifier.keyVersion,
      },
      {
        organizationId: profile.organizationId,
        projectId: profile.projectId,
        connectionId: session.state,
        credentialType: 'client_secret',
      },
    );
  }

  try {
    const result = await completeAuthorization({
      db: c.get('db'),
      env: c.env,
      context: providerCallContext(c, { timeoutMs: DESTINATION_TIMEOUT_MS }),
      provider: session.provider,
      query,
      codeVerifier,
      organizationId: profile.organizationId,
      projectId: profile.projectId,
      projectEnvironmentId: session.projectEnvironmentId,
      profileId: session.profileId,
      providerAppId: session.providerAppId,
      redirectUri: session.redirectUri,
      traceId: trace.traceId,
    });

    return back({
      connection_id: toPublicId('connection', result.connectionId),
      provider: session.provider,
      status: result.setupComplete ? 'connected' : 'destination_selection_required',
    });
  } catch (error) {
    await failOAuthSession(c.get('db'), session.id);
    // The message is logged, not redirected: a provider error string can quote the
    // request that produced it, and that request carried an authorization code.
    logger.warn('connect.exchange_failed', {
      provider,
      reason: error instanceof Error ? error.message : String(error),
    });
    return back({
      error: error instanceof ApiError ? error.code : 'AUTHORIZATION_FAILED',
    });
  }
});

// ---------------------------------------------------------------------------
// After connecting
// ---------------------------------------------------------------------------

async function loadOwnedConnection(
  c: Context<AppEnv>,
  connectionId: string,
): Promise<ConnectionWithScopes> {
  const principal = c.get('principal');

  const row = await findConnectionById(c.get('db'), principal.projectEnvironmentId, connectionId);
  if (!row) throw new ApiError('CONNECTION_NOT_FOUND');

  if (principal.restrictedToProfileId !== null && principal.restrictedToProfileId !== row.profileId) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  return row;
}

connectRoutes.post(
  '/:connectionId/destinations/select',
  withDatabase(),
  authenticate(['connections:write']),
  async (c) => {
    const principal = c.get('principal');
    const connectionId = requirePathId(c, 'connection', 'connectionId');
    const body = await parseBody(c, SelectDestinationsRequestSchema);

    await loadOwnedConnection(c, connectionId);

    const internalIds: string[] = [];
    for (const publicId of body.destination_ids) {
      const internal = fromPublicId('destination', publicId);
      if (!internal) {
        throw new ApiError('INVALID_REQUEST', {
          message: `\`${publicId}\` is not a valid destination id.`,
          param: 'destination_ids',
        });
      }
      internalIds.push(internal);
    }

    const rows = await selectConnectionDestinations(c.get('db'), {
      projectEnvironmentId: principal.projectEnvironmentId,
      connectionId,
      destinationIds: internalIds,
    });

    // Selecting an id belonging to another connection silently selects nothing, which
    // would read as success. Comparing counts turns it into an error that names the cause.
    const selected = rows.filter((row) => row.selected).length;
    if (selected !== internalIds.length) {
      throw new ApiError('DESTINATION_NOT_FOUND', {
        message: 'One or more destination ids do not belong to this connection.',
        param: 'destination_ids',
      });
    }

    return c.json(
      DestinationListResponseSchema.parse({
        object: 'list',
        data: rows.map(toDestinationResponse),
        has_more: false,
        next_cursor: null,
      }),
      200,
    );
  },
);

/**
 * Refresh a connection's credentials on demand (plan §14, §42).
 *
 * The proactive sweep in the reconciler is what normally keeps tokens alive; this is the
 * manual door for an integrator who has just fixed something at the provider and wants to
 * confirm it, and for the dashboard's "check connection" button.
 *
 * The refresh lock is taken for the same reason the background sweep takes it: many
 * providers invalidate the previous refresh token when they issue a new one, so two
 * concurrent refreshes leave one of them holding a token the provider has already
 * revoked, and the connection breaks in a way that looks random.
 */
connectRoutes.post(
  '/:connectionId/refresh',
  withDatabase(),
  authenticate(['connections:write']),
  async (c) => {
    const connectionId = requirePathId(c, 'connection', 'connectionId');
    const connection = await loadOwnedConnection(c, connectionId);

    if (connection.disconnectedAt) {
      throw new ApiError('CONNECTION_DISCONNECTED', {
        message: 'A disconnected connection cannot be refreshed. Reconnect the account instead.',
      });
    }

    if (!isProviderName(connection.provider)) {
      throw new ApiError('INTERNAL_ERROR', {
        message: `Connection names unknown provider "${connection.provider}".`,
      });
    }

    const adapter = requireAdapter(connection.provider);

    if (!(await acquireRefreshLock(c.get('db'), connectionId))) {
      throw new ApiError('CONFLICTING_STATE', {
        message: 'A refresh for this connection is already in progress.',
      });
    }

    try {
      const stored = await findConnectionCredentials(c.get('db'), connectionId);
      if (stored.length === 0) {
        throw new ApiError('CONNECTION_REAUTH_REQUIRED', {
          message: 'No credentials are stored for this connection.',
        });
      }

      const cipher = credentialCipher(c.env);
      const decrypted: Record<string, string> = {};
      for (const record of stored) {
        decrypted[record.credentialType] = await cipher.decrypt(
          {
            ciphertext: record.ciphertext,
            nonce: record.nonce,
            algorithm: record.algorithm as typeof CREDENTIAL_ALGORITHM,
            keyVersion: record.keyVersion,
          },
          {
            organizationId: connection.organizationId,
            projectId: connection.projectId,
            connectionId,
            credentialType: record.credentialType,
            destinationId: record.destinationId,
          },
        );
      }

      const app = await resolveProviderApp(
        c.get('db'),
        c.env,
        connection.provider,
        adapter.authStrategy,
        connection.projectId,
        callbackUrlFor(apiOrigin(c), connection.provider),
      );

      const refreshed = await adapter.auth.refresh({
        context: providerCallContext(c, { timeoutMs: CONNECT_TIMEOUT_MS }),
        app: app?.credentials ?? null,
        credentials: {
          strategy: connection.authStrategy,
          accessToken: decrypted.access_token,
          refreshToken: decrypted.refresh_token,
          secret: decrypted.app_password ?? decrypted.bot_token ?? decrypted.api_key,
          tokenSecret: decrypted.oauth1_token_secret,
          externalAccountId: connection.providerAccountId,
          grantedScopes: connection.grantedScopes,
          metadata: connection.metadata,
        },
      });

      if (refreshed.rotated) {
        const expiresAt = refreshed.credentials.expiresAt
          ? new Date(refreshed.credentials.expiresAt)
          : null;

        for (const [type, value] of [
          ['access_token', refreshed.credentials.accessToken],
          ['refresh_token', refreshed.credentials.refreshToken],
        ] as const) {
          if (!value) continue;
          const record = await cipher.encrypt(value, {
            organizationId: connection.organizationId,
            projectId: connection.projectId,
            connectionId,
            credentialType: type,
          });
          await storeCredential(c.get('db'), {
            connectionId,
            organizationId: connection.organizationId,
            projectId: connection.projectId,
            credentialType: type,
            ciphertext: record.ciphertext,
            nonce: record.nonce,
            algorithm: record.algorithm,
            keyVersion: record.keyVersion,
            expiresAt: type === 'access_token' ? expiresAt : null,
          });
        }
      }

      await setConnectionHealth(c.get('db'), connectionId, 'healthy', null);

      return c.json(
        RefreshConnectionResponseSchema.parse({
          id: toPublicId('connection', connectionId),
          object: 'connection',
          health: 'healthy',
          rotated: refreshed.rotated,
        }),
        200,
      );
    } catch (error) {
      // Our own preconditions — no stored credential, a disconnected connection — are
      // already the right answer and are re-thrown untouched. Passing one through the
      // provider error taxonomy would ask an adapter to classify an error no provider
      // produced, and the taxonomy is entitled to throw on input it does not recognize.
      if (error instanceof ApiError) {
        await setConnectionHealth(c.get('db'), connectionId, 'reauth_required', error.message);
        throw error;
      }

      // A refresh that fails at the provider is diagnostic, not incidental: it is the
      // moment we learn the user revoked access. Recording it means the dashboard says so
      // before a scheduled post fails at 9am.
      const normalized = adapter.normalizeError(error, {
        operation: 'refreshCredential',
        provider: connection.provider,
      });
      await setConnectionHealth(c.get('db'), connectionId, 'reauth_required', normalized.message);
      throw new ApiError('CONNECTION_REAUTH_REQUIRED', {
        message: normalized.message,
        cause: error,
      });
    } finally {
      await releaseRefreshLock(c.get('db'), connectionId);
    }
  },
);

connectRoutes.get(
  '/:connectionId/destinations/all',
  withDatabase(),
  authenticate(['destinations:read']),
  async (c) => {
    const principal = c.get('principal');
    const connectionId = requirePathId(c, 'connection', 'connectionId');
    await loadOwnedConnection(c, connectionId);

    const rows = await listDestinationsForConnection(
      c.get('db'),
      principal.projectEnvironmentId,
      connectionId,
      { includeRemoved: true },
    );

    return c.json(
      DestinationListResponseSchema.parse({
        object: 'list',
        data: rows.map(toDestinationResponse),
        has_more: false,
        next_cursor: null,
      }),
      200,
    );
  },
);
