import { toPublicId } from '@gs/contracts/ids';
import { CredentialCipher, Keyring, type CREDENTIAL_ALGORITHM } from '@gs/crypto';
import {
  acquireRefreshLock,
  emitWebhookEvent,
  findConnectionCredentials,
  releaseRefreshLock,
  setConnectionHealth,
  storeCredential,
  type ConnectionDueForRefresh,
  type Database,
} from '@gs/db';
import { CURRENT_WEBHOOK_API_VERSION } from '@gs/events';
import { dispositionFor } from '@gs/errors';
import type { Logger } from '@gs/observability';
import { callbackUrlFor, resolveProviderApp } from '@gs/platform-credentials';
import type { ProviderCredentials } from '@gs/provider-kit';
import { getAdapter, hasAdapter } from '@gs/providers';

import type { Env } from './env.js';
import { providerContext } from './provider-context.js';

/**
 * Proactive credential refresh (plan §42).
 *
 * Refreshing *before* expiry rather than on failure is the whole point. The alternative is
 * discovering the problem mid-publish, where the only options left are a delayed retry or
 * a failed post — and where the customer finds out from a post that did not go out.
 *
 * Every step here is written around one hazard: most OAuth providers invalidate the old
 * refresh token the moment a new one is issued. Two workers refreshing the same connection
 * concurrently therefore does not produce a harmless duplicate — the slower one writes a
 * token the provider has already revoked, and the connection breaks for good. The
 * per-connection lock is what prevents that, and it is not optional.
 */

/** Per-call budget. Well inside the lock, so a hung provider frees the connection. */
const REFRESH_TIMEOUT_MS = 20_000;

/**
 * How long one worker may hold a connection.
 *
 * Long enough to cover a slow provider plus the write that follows, short enough that a
 * worker killed mid-refresh does not strand the connection until the next deploy.
 */
const LOCK_SECONDS = 90;

export type RefreshOutcome =
  | 'refreshed'
  | 'still_valid'
  /** Someone else holds the lock. Normal under overlapping crons; not a failure. */
  | 'locked'
  /** Nothing here can fix it. The customer has been told. */
  | 'reauth_required'
  /** Transient. Left alone for the next sweep. */
  | 'deferred'
  /** This provider does not issue refreshable credentials. */
  | 'not_refreshable';

export async function refreshConnection(
  db: Database,
  env: Env,
  row: ConnectionDueForRefresh,
  logger: Logger,
): Promise<RefreshOutcome> {
  if (!hasAdapter(row.provider)) return 'not_refreshable';

  /**
   * A refresh token that has itself expired cannot produce anything.
   *
   * Checked before taking the lock and before calling the provider, because the answer is
   * already known: this connection needs a human, and asking the provider first would just
   * be a guaranteed-failing network call on every sweep.
   */
  if (row.refreshExpiresAt && row.refreshExpiresAt.getTime() <= Date.now()) {
    await reportReauthRequired(db, row, 'refresh_token_expired', logger);
    return 'reauth_required';
  }

  if (!(await acquireRefreshLock(db, row.connectionId, LOCK_SECONDS))) return 'locked';

  try {
    const stored = await findConnectionCredentials(db, row.connectionId);
    const refreshToken = stored.find((entry) => entry.credentialType === 'refresh_token');
    const accessToken = stored.find((entry) => entry.credentialType === 'access_token');

    if (!accessToken) {
      await reportReauthRequired(db, row, 'no_stored_credential', logger);
      return 'reauth_required';
    }

    /**
     * No refresh token means nothing to refresh with.
     *
     * Not an error: a Bluesky app password and a Telegram bot token never expire and never
     * rotate. But an *expiring* credential with no way to renew it is a connection that
     * will stop working on a known date, and the customer should hear about it before then
     * rather than afterwards.
     */
    if (!refreshToken) {
      await setConnectionHealth(db, row.connectionId, 'refresh_due', 'No refresh token is stored.', {
        reason: 'no_refresh_token',
      });
      return 'not_refreshable';
    }

    const cipher = new CredentialCipher(Keyring.fromEnv(env));

    const decrypt = async (entry: (typeof stored)[number]): Promise<string> =>
      cipher.decrypt(
        {
          ciphertext: entry.ciphertext,
          nonce: entry.nonce,
          algorithm: entry.algorithm as typeof CREDENTIAL_ALGORITHM,
          keyVersion: entry.keyVersion,
        },
        {
          organizationId: row.organizationId,
          projectId: row.projectId,
          connectionId: row.connectionId,
          credentialType: entry.credentialType,
          destinationId: entry.destinationId,
        },
      );

    const credentials: ProviderCredentials = {
      strategy: row.authStrategy,
      accessToken: await decrypt(accessToken),
      refreshToken: await decrypt(refreshToken),
      externalAccountId: row.providerAccountId,
      grantedScopes: accessToken.grantedScopes,
      metadata: accessToken.connectionMetadata,
    };

    const resolution = await resolveProviderApp(db, {
      provider: row.provider,
      authStrategy: row.authStrategy,
      projectId: row.projectId,
      redirectUri: callbackUrlFor(env.PUBLIC_API_ORIGIN ?? '', row.provider),
      env,
    });

    if (resolution.kind === 'unavailable') {
      // Not the connection's fault and not fixable by re-authorizing. Left for the next
      // sweep, which will succeed the moment the application is configured.
      logger.warn('connection_health.app_unavailable', {
        provider: row.provider,
        reason: resolution.reason,
      });
      return 'deferred';
    }

    const adapter = getAdapter(row.provider);
    const context = providerContext(env, {
      requestId: `refresh_${row.connectionId}`,
      traceId: `trc_refresh_${row.connectionId}`,
      timeoutMs: REFRESH_TIMEOUT_MS,
      logger,
    });

    let result;
    try {
      result = await adapter.auth.refresh({
        context,
        app: resolution.kind === 'resolved' ? resolution.credentials : null,
        credentials,
      });
    } catch (error) {
      const normalized = adapter.normalizeError(error, {
        operation: 'refresh',
        provider: row.provider,
      });

      /**
       * Branch on the disposition, not on `isRetryable`.
       *
       * `AUTH_EXPIRED` is marked retryable in the taxonomy precisely *because* a refresh is
       * supposed to be attempted first — but this code is that attempt. Reading its
       * retryability here would defer the one failure that can only be fixed by a human,
       * and the connection would sit in `refresh_due` until the token died, silently.
       *
       * `blocked_on_connection` is the disposition that means "no automated recovery
       * exists" (plan §42), so it, and only it, escalates to the customer. Anything else —
       * a 503, a rate limit — is a provider having a bad minute, and telling the customer
       * to reconnect a working account would revoke a token that was fine.
       */
      const disposition = dispositionFor(normalized);

      if (disposition !== 'blocked_on_connection') {
        logger.warn('connection_health.refresh_deferred', {
          provider: row.provider,
          code: normalized.code,
        });
        await setConnectionHealth(db, row.connectionId, 'refresh_due', normalized.message, {
          reason: 'refresh_deferred',
          providerErrorCode: normalized.code,
        });
        return 'deferred';
      }

      await reportReauthRequired(db, row, normalized.code, logger);
      return 'reauth_required';
    }

    if (!result.rotated) {
      // The provider handed back the same still-valid credential. Re-encrypting and
      // rewriting it would churn ciphertext for no change and, on providers that count
      // writes against a quota, for no reason.
      await setConnectionHealth(db, row.connectionId, 'healthy', null, { reason: 'still_valid' });
      return 'still_valid';
    }

    await persistRotatedCredentials(db, cipher, row, result.credentials);

    await setConnectionHealth(db, row.connectionId, 'healthy', null, { reason: 'refreshed' });

    logger.info('connection_health.refreshed', {
      provider: row.provider,
      connectionId: row.connectionId,
    });
    return 'refreshed';
  } finally {
    /**
     * Always released, including after a throw.
     *
     * A lock left held by a crashed worker blocks every later sweep until it times out,
     * and the credential it protects expires on schedule regardless.
     */
    await releaseRefreshLock(db, row.connectionId);
  }
}

/**
 * Write the rotated credentials.
 *
 * One transaction covering both tokens, because a provider that rotates the refresh token
 * has already invalidated the old one: writing the new access token and then failing to
 * write the new refresh token would leave a connection that works today and cannot ever
 * refresh again — the worst of the possible outcomes, because it looks healthy.
 */
async function persistRotatedCredentials(
  db: Database,
  cipher: CredentialCipher,
  row: ConnectionDueForRefresh,
  next: ProviderCredentials,
): Promise<void> {
  const context = {
    organizationId: row.organizationId,
    projectId: row.projectId,
    connectionId: row.connectionId,
  };

  const expiresAt = next.expiresAt ? new Date(next.expiresAt) : null;

  const accessCipher = next.accessToken
    ? await cipher.encrypt(next.accessToken, { ...context, credentialType: 'access_token' })
    : null;

  const refreshCipher = next.refreshToken
    ? await cipher.encrypt(next.refreshToken, { ...context, credentialType: 'refresh_token' })
    : null;

  await db.transaction(async (tx) => {
    if (accessCipher) {
      await storeCredential(tx, {
        connectionId: row.connectionId,
        organizationId: row.organizationId,
        projectId: row.projectId,
        credentialType: 'access_token',
        ciphertext: accessCipher.ciphertext,
        nonce: accessCipher.nonce,
        algorithm: accessCipher.algorithm,
        keyVersion: accessCipher.keyVersion,
        expiresAt,
      });
    }

    if (refreshCipher) {
      await storeCredential(tx, {
        connectionId: row.connectionId,
        organizationId: row.organizationId,
        projectId: row.projectId,
        credentialType: 'refresh_token',
        ciphertext: refreshCipher.ciphertext,
        nonce: refreshCipher.nonce,
        algorithm: refreshCipher.algorithm,
        keyVersion: refreshCipher.keyVersion,
      });
    }
  });
}

/**
 * Tell the customer their account needs reconnecting (plan §42).
 *
 * Emitted only when the health transition actually moved. `connection.reauth_required` is
 * the event an alert gets built on, and an alert that fires on every sweep of an already
 * broken connection is an alert that gets muted — after which the next real one is missed.
 */
async function reportReauthRequired(
  db: Database,
  row: ConnectionDueForRefresh,
  reason: string,
  logger: Logger,
): Promise<void> {
  const transition = await setConnectionHealth(
    db,
    row.connectionId,
    'reauth_required',
    `Automated refresh could not recover this connection (${reason}).`,
    { reason, providerErrorCode: reason },
  );

  if (!transition.changed) return;

  await emitWebhookEvent(db, {
    organizationId: row.organizationId,
    projectId: row.projectId,
    projectEnvironmentId: row.projectEnvironmentId,
    profileId: row.profileId,
    eventType: 'connection.reauth_required',
    apiVersion: CURRENT_WEBHOOK_API_VERSION,
    payload: {
      connection_id: toPublicId('connection', row.connectionId),
      provider: row.provider,
      health: 'reauth_required',
      reason,
      detected_by: 'proactive_refresh',
    },
    aggregateType: 'connection',
    aggregateId: row.connectionId,
  });

  logger.warn('connection_health.reauth_required', {
    provider: row.provider,
    connectionId: row.connectionId,
    reason,
  });
}
