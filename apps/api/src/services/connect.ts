import { newUuidV7, toPublicId } from '@gs/contracts/ids';
import type { AuthStrategy, ProviderName } from '@gs/contracts/providers';
import { bytesToBase64Url, randomBytes, type CREDENTIAL_ALGORITHM } from '@gs/crypto';
import {
  createOAuthSession,
  emitWebhookEvent,
  findProfileById,
  findProviderApp,
  planConnectionIds,
  saveConnection,
  upsertProviderApp,
  type Database,
  type EncryptedCredentialInput,
  type SaveDestinationInput,
  type SocialCredential,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { CURRENT_WEBHOOK_API_VERSION } from '@gs/events';
import { getAdapter, hasAdapter } from '@gs/providers';
import type {
  ProviderCallContext,
  ProviderCredentials,
  ProviderDestination,
  SocialProviderAdapter,
} from '@gs/provider-kit';

import type { Env } from '../env.js';
import { callbackUrlFor, credentialCipher, resolveProviderApp } from './provider-apps.js';

/**
 * Connecting a social account (plan §21, §22).
 *
 * This is the one flow the whole product waits on: the publishing engine, the capability
 * registry, preflight and every adapter are inert until an account is attached to a
 * profile. Two entry points funnel into the same completion path:
 *
 *   OAuth               the provider redirects to our callback with a code
 *   direct credential   the user pastes an app password or bot token
 *
 * They converge deliberately. `exchangeCallback` on the adapter takes a bag of query
 * parameters and interprets them itself (plan §19), so Bluesky reading `identifier` and
 * `password` and LinkedIn reading `code` are the same call as far as the engine is
 * concerned. The alternative — an `if (strategy === 'oauth2')` in the engine — is exactly
 * the provider-specific branching plan P1 forbids outside the adapter packages.
 */

/** OAuth handshakes are short-lived by design: a stale one is a replay opportunity. */
const AUTHORIZATION_TTL_SECONDS = 900;

/** Connect and identity calls are interactive — a user is watching a spinner. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Destination discovery can page through Pages or organizations. */
const DESTINATION_TIMEOUT_MS = 45_000;

export function requireAdapter(provider: string): SocialProviderAdapter {
  if (!hasAdapter(provider)) {
    throw new ApiError('PROVIDER_NOT_SUPPORTED', {
      message: `No adapter is available for "${provider}" yet.`,
      param: 'provider',
    });
  }
  return getAdapter(provider as ProviderName);
}

/**
 * Validate a customer-supplied return URL (plan §21.1, §67).
 *
 * The URL is checked here, stored, and then used verbatim at callback time. Nothing from
 * the provider's callback query is ever redirected to — that is the actual defence. An
 * open redirect on an OAuth callback is not a cosmetic issue: the callback URL is where
 * the authorization code lands, and bouncing it to an attacker-chosen host hands over the
 * connection.
 *
 * HTTP is permitted only for loopback, because a developer building against localhost has
 * no way to serve HTTPS and no meaningful exposure.
 */
export function assertAllowedRedirect(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError('REDIRECT_URL_NOT_ALLOWED', {
      message: '`redirect_url` must be an absolute URL.',
      param: 'redirect_url',
    });
  }

  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new ApiError('REDIRECT_URL_NOT_ALLOWED', {
      message: '`redirect_url` must use HTTPS, except on localhost.',
      param: 'redirect_url',
    });
  }

  // Credentials in a redirect target are never intentional and would be logged by every
  // hop between here and the browser.
  if (url.username || url.password) {
    throw new ApiError('REDIRECT_URL_NOT_ALLOWED', {
      message: '`redirect_url` must not embed credentials.',
      param: 'redirect_url',
    });
  }

  return url;
}

/** 32 bytes of randomness. The only thing binding a callback to the flow that started it. */
export function newAuthorizationState(): string {
  return bytesToBase64Url(randomBytes(32));
}

export function authorizationExpiry(): Date {
  return new Date(Date.now() + AUTHORIZATION_TTL_SECONDS * 1000);
}

/**
 * Map an adapter credential onto the rows that persist it.
 *
 * The credential type is not cosmetic: it is part of the encryption AAD, so a refresh
 * token written into the access-token slot fails to decrypt rather than being used as an
 * access token. `strategy` decides which slot a single opaque secret belongs in.
 */
function credentialParts(
  credentials: ProviderCredentials,
): { type: SocialCredential['credentialType']; value: string; expiresAt: Date | null }[] {
  const parts: { type: SocialCredential['credentialType']; value: string; expiresAt: Date | null }[] =
    [];

  const expiresAt = credentials.expiresAt ? new Date(credentials.expiresAt) : null;

  if (credentials.accessToken) {
    parts.push({ type: 'access_token', value: credentials.accessToken, expiresAt });
  }
  if (credentials.refreshToken) {
    // A refresh token's own lifetime is tracked separately; it is not the access token's.
    parts.push({ type: 'refresh_token', value: credentials.refreshToken, expiresAt: null });
  }
  if (credentials.tokenSecret) {
    parts.push({ type: 'oauth1_token_secret', value: credentials.tokenSecret, expiresAt: null });
  }

  if (credentials.secret) {
    const type: SocialCredential['credentialType'] =
      credentials.strategy === 'app_password'
        ? 'app_password'
        : credentials.strategy === 'bot_token'
          ? 'bot_token'
          : credentials.strategy === 'webhook_url'
            ? 'webhook_url'
            : 'api_key';
    parts.push({ type, value: credentials.secret, expiresAt });
  }

  return parts;
}

/**
 * What a provider with no consent screen needs the user to type.
 *
 * Derived from the authentication strategy, never from the provider name — a `switch` on
 * `provider` here would be provider-specific logic in the core, which plan P1 forbids and
 * `pnpm boundaries` enforces. The field names match what the adapters read from the
 * callback query, and adding a strategy is a compile error until it is handled here.
 */
export interface CredentialField {
  name: string;
  label: string;
  type: 'text' | 'password';
  help: string | null;
}

export function credentialFields(strategy: AuthStrategy): CredentialField[] {
  switch (strategy) {
    case 'app_password':
      return [
        {
          name: 'identifier',
          label: 'Handle',
          type: 'text',
          help: 'Your full handle, for example alice.bsky.social.',
        },
        {
          name: 'password',
          label: 'App password',
          type: 'password',
          help: 'An app-specific password, not your account password.',
        },
      ];
    case 'bot_token':
      return [
        {
          name: 'token',
          label: 'Bot token',
          type: 'password',
          help: 'The token issued when the bot was created.',
        },
      ];
    case 'api_key':
      return [{ name: 'api_key', label: 'API key', type: 'password', help: null }];
    case 'manual_token':
      return [{ name: 'access_token', label: 'Access token', type: 'password', help: null }];
    case 'webhook_url':
      return [{ name: 'webhook_url', label: 'Webhook URL', type: 'text', help: null }];
    // Redirect-based strategies collect nothing here: the provider's own consent screen
    // does it, which is the entire point of OAuth.
    case 'oauth2':
    case 'oauth2_pkce':
    case 'oauth1':
    case 'custom':
      return [];
  }
}

export function isRedirectStrategy(strategy: AuthStrategy): boolean {
  return strategy === 'oauth2' || strategy === 'oauth2_pkce' || strategy === 'oauth1';
}

export interface BeginAuthorizationInput {
  db: Database;
  env: Env;
  context: ProviderCallContext;
  provider: ProviderName;
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  profileId: string;
  /** Validated by the caller before this runs. Stored, and redirected to verbatim later. */
  returnUrl: string | null;
  requestedScopes: readonly string[];
  options: Record<string, string>;
  apiOrigin: string;
  connectSessionId?: string | null;
  traceId: string;
}

export interface BeginAuthorizationResult {
  authorizationUrl: string;
  state: string;
  oauthSessionId: string;
  completion: 'redirect' | 'credential';
  requiredCredentialFields: CredentialField[];
  expiresAt: Date;
}

/**
 * Start an authorization (plan §21.1 steps 1–7).
 *
 * Shared by the integrator API and the hosted connect page, because they differ only in
 * how the caller was authenticated — an API key in one case, a signed session token in
 * the other. Duplicating the handshake for the second caller is how the two drift until
 * one of them forgets to bind the state to a tenant.
 */
export async function beginAuthorization(
  input: BeginAuthorizationInput,
): Promise<BeginAuthorizationResult> {
  const adapter = requireAdapter(input.provider);
  const redirectUri = callbackUrlFor(input.apiOrigin, input.provider);

  const app = await resolveProviderApp(
    input.db,
    input.env,
    input.provider,
    adapter.authStrategy,
    input.projectId,
    redirectUri,
  );

  const state = newAuthorizationState();
  const expiresAt = authorizationExpiry();

  const redirect = await adapter.auth.createAuthorization({
    context: input.context,
    app: app?.credentials ?? null,
    state,
    requestedScopes: input.requestedScopes,
    options: input.options,
  });

  // An adapter that returns a different state than it was given would break the CSRF
  // binding silently: the callback would carry a value no session row matches, and every
  // connect attempt for that provider would fail with "invalid link".
  if (redirect.state !== state) {
    throw new ApiError('INTERNAL_ERROR', {
      message: `The ${input.provider} adapter altered the authorization state.`,
    });
  }

  // PKCE verifiers are secrets in exactly the way tokens are — anyone holding one can
  // complete an intercepted authorization — so they are encrypted at rest like any other
  // credential (plan §21.1). No connection exists yet, so the state, which is unique per
  // handshake, stands in as the binding identifier.
  const encryptedCodeVerifier = redirect.codeVerifier
    ? await credentialCipher(input.env).encrypt(redirect.codeVerifier, {
        organizationId: input.organizationId,
        projectId: input.projectId,
        connectionId: state,
        credentialType: 'client_secret',
      })
    : null;

  const session = await createOAuthSession(input.db, {
    projectEnvironmentId: input.projectEnvironmentId,
    profileId: input.profileId,
    providerAppId: app?.row.id ?? (await ensurePlatformAppRow(input.db, input.provider)),
    provider: input.provider,
    state,
    encryptedCodeVerifier,
    redirectUri,
    returnUrl: input.returnUrl,
    requestedScopes: input.requestedScopes,
    connectSessionId: input.connectSessionId ?? null,
    expiresAt,
    traceId: input.traceId,
  });

  return {
    authorizationUrl: redirect.authorizationUrl,
    state,
    oauthSessionId: session.id,
    completion: isRedirectStrategy(adapter.authStrategy) ? 'redirect' : 'credential',
    requiredCredentialFields: credentialFields(adapter.authStrategy),
    expiresAt,
  };
}

/**
 * A provider app row for strategies that need no registered application.
 *
 * `oauth_sessions.provider_app_id` is NOT NULL, which is right for OAuth and awkward for
 * Bluesky. Rather than loosen the column — it is what guarantees an OAuth session can
 * always name the credentials it was started under — a platform-managed row is created on
 * demand with no client id or secret. It records that the handshake happened under our
 * platform application, which is true.
 */
async function ensurePlatformAppRow(db: Database, provider: string): Promise<string> {
  const existing = await findProviderApp(db, provider, null);
  if (existing) return existing.id;

  const created = await upsertProviderApp(db, {
    provider,
    projectId: null,
    ownership: 'platform_managed',
    clientId: '',
    // No secret exists to encrypt. This is never decrypted, because `resolveProviderApp`
    // returns null for these strategies before it looks at the record at all.
    encryptedClientSecret: { ciphertext: '', nonce: '', algorithm: 'AES-256-GCM', keyVersion: 0 },
    redirectUri: '',
    scopes: [],
    approvalStatus: 'not_required',
  });

  return created.id;
}

export interface CompleteAuthorizationInput {
  db: Database;
  env: Env;
  context: ProviderCallContext;
  provider: ProviderName;
  /** Raw callback parameters, or the credential fields for a direct-credential provider. */
  query: Record<string, string>;
  codeVerifier?: string;
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  profileId: string;
  providerAppId: string | null;
  /** The URL registered with the provider. Must match the one used to authorize. */
  redirectUri: string;
  traceId: string;
}

export interface CompleteAuthorizationResult {
  connectionId: string;
  created: boolean;
  destinationCount: number;
  setupComplete: boolean;
  accountName: string;
  grantedScopes: string[];
}

/**
 * Exchange a callback for a stored connection (plan §21.2 steps 3–9).
 *
 * Destinations are discovered before anything is written, so a *failure* to list them
 * surfaces as an authorization problem rather than as a healthy-looking connection that
 * cannot publish.
 *
 * An empty list is not a failure, though, and must not be treated as one: Telegram
 * legitimately returns none until the customer names the chats their bot posts to. The
 * connection is stored with `setup_completed_at` null, which is the honest state — it
 * exists, it authenticated, and it has nowhere to publish yet. Preflight reports that as
 * CONNECTION_INCOMPLETE_SETUP rather than letting it fail at publish time.
 */
export async function completeAuthorization(
  input: CompleteAuthorizationInput,
): Promise<CompleteAuthorizationResult> {
  const adapter = requireAdapter(input.provider);

  const app = await resolveProviderApp(
    input.db,
    input.env,
    input.provider,
    adapter.authStrategy,
    input.projectId,
    input.redirectUri,
  );

  const result = await adapter.auth.exchangeCallback({
    context: input.context,
    app: app?.credentials ?? null,
    query: input.query,
    codeVerifier: input.codeVerifier,
  });

  let discovered: ProviderDestination[];
  try {
    discovered = await adapter.destinations.list({
      context: input.context,
      app: app?.credentials ?? null,
      credentials: result.credentials,
    });
  } catch (cause) {
    const normalized = adapter.normalizeError(cause, {
      operation: 'listDestinations',
      provider: input.provider,
    });
    throw new ApiError('AUTHORIZATION_FAILED', {
      message:
        `Authorization succeeded but no publishable destinations could be read from ` +
        `${input.provider}: ${normalized.message}`,
      cause,
    });
  }

  // Ids first, because the credential AAD binds them (ADR-007) and encryption therefore
  // cannot happen until they are known.
  const plan = await planConnectionIds(input.db, {
    profileId: input.profileId,
    provider: input.provider,
    providerAccountId: result.identity.externalAccountId,
  });

  const cipher = credentialCipher(input.env);

  const encrypt = async (
    plaintext: string,
    credentialType: SocialCredential['credentialType'],
    destinationId: string | null,
    expiresAt: Date | null,
  ): Promise<EncryptedCredentialInput> => {
    const record = await cipher.encrypt(plaintext, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      connectionId: plan.connectionId,
      credentialType,
      destinationId,
    });

    return {
      credentialType,
      ciphertext: record.ciphertext,
      nonce: record.nonce,
      algorithm: record.algorithm satisfies typeof CREDENTIAL_ALGORITHM,
      keyVersion: record.keyVersion,
      expiresAt,
      refreshExpiresAt: null,
    };
  };

  const connectionCredentials: EncryptedCredentialInput[] = [];
  for (const part of credentialParts(result.credentials)) {
    connectionCredentials.push(await encrypt(part.value, part.type, null, part.expiresAt));
  }

  const destinations: SaveDestinationInput[] = [];
  for (const destination of discovered) {
    const destinationId =
      plan.destinationIdByExternalId.get(destination.externalId) ?? newUuidV7();

    const destinationCredentials: EncryptedCredentialInput[] = [];
    if (destination.credentials) {
      for (const part of credentialParts(destination.credentials)) {
        destinationCredentials.push(
          await encrypt(part.value, part.type, destinationId, part.expiresAt),
        );
      }
    }

    destinations.push({
      destinationId,
      externalId: destination.externalId,
      name: destination.displayName,
      handle: destination.handle,
      avatarUrl: destination.avatarUrl,
      url: typeof destination.metadata.url === 'string' ? destination.metadata.url : null,
      destinationType: destination.kind,
      metadata: destination.metadata as Record<string, unknown>,
      credentials: destinationCredentials,
    });
  }

  const saved = await saveConnection(input.db, {
    connectionId: plan.connectionId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    projectEnvironmentId: input.projectEnvironmentId,
    profileId: input.profileId,
    provider: input.provider,
    authStrategy: adapter.authStrategy,
    providerAppId: input.providerAppId,
    providerAccountId: result.identity.externalAccountId,
    providerAccountName: result.identity.displayName,
    providerAccountHandle: result.identity.handle,
    providerAccountAvatarUrl: result.identity.avatarUrl,
    grantedScopes: result.identity.grantedScopes,
    // Non-secret strategy extras: a Bluesky PDS endpoint, a Meta account type. The
    // credential metadata is where an adapter puts what it needs to make its next call,
    // and it is contractually free of secrets (plan §19).
    metadata: {
      ...(result.credentials.metadata as Record<string, unknown>),
      ...(result.identity.accountType ? { account_type: result.identity.accountType } : {}),
    },
    credentials: connectionCredentials,
    destinations,
  });

  // Step 9 — tell the customer. A connection appearing without an event means an
  // integrator has to poll to notice their own user finished connecting.
  await emitWebhookEvent(input.db, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    projectEnvironmentId: input.projectEnvironmentId,
    profileId: input.profileId,
    eventType: 'connection.connected',
    apiVersion: CURRENT_WEBHOOK_API_VERSION,
    payload: {
      connection_id: toPublicId('connection', saved.connectionId),
      profile_id: toPublicId('profile', input.profileId),
      provider: input.provider,
      provider_account_id: result.identity.externalAccountId,
      provider_account_name: result.identity.displayName,
      destination_count: saved.destinationCount,
      setup_complete: saved.setupCompletedAt !== null,
      reconnected: !saved.created,
    },
    aggregateType: 'connection',
    aggregateId: saved.connectionId,
    traceId: input.traceId,
  });

  return {
    connectionId: saved.connectionId,
    created: saved.created,
    destinationCount: saved.destinationCount,
    setupComplete: saved.setupCompletedAt !== null,
    accountName: result.identity.displayName,
    grantedScopes: [...result.identity.grantedScopes],
  };
}

/** Resolve and authorize the profile an authorization will attach to. */
export async function loadOwnedProfile(
  db: Database,
  projectEnvironmentId: string,
  profileId: string,
  restrictedToProfileId: string | null,
): Promise<{ id: string; name: string }> {
  const profile = await findProfileById(db, projectEnvironmentId, profileId);
  if (!profile) throw new ApiError('PROFILE_NOT_FOUND');

  if (restrictedToProfileId !== null && restrictedToProfileId !== profile.id) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  if (profile.disabledAt) {
    throw new ApiError('CONFLICTING_STATE', {
      message: 'This profile is disabled and cannot connect new accounts.',
    });
  }

  return { id: profile.id, name: profile.name };
}

export { CONNECT_TIMEOUT_MS, DESTINATION_TIMEOUT_MS, callbackUrlFor };
