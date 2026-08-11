import { requiresProviderApp, type AuthStrategy, type ProviderName } from '@gs/contracts/providers';
import { CredentialCipher, Keyring, type CREDENTIAL_ALGORITHM } from '@gs/crypto';
import { findProviderApp, type Database, type ProviderApp } from '@gs/db';
import { ApiError } from '@gs/errors';
import type { ProviderAppCredentials } from '@gs/provider-kit';

import type { Env } from '../env.js';

/**
 * Resolving the registered platform application for a provider call (plan §23).
 *
 * This is the mechanism that makes a granted platform approval a data change rather than
 * a deploy: the client id and secret live in `provider_apps`, are resolved at call time,
 * and prefer a customer's own application over the shared platform default.
 *
 * The secret is decrypted here and handed straight to the adapter (P9, §7.2). It is never
 * logged, never returned from an endpoint, and never held beyond the call that needs it.
 */

/** Built once per request that needs it; constructing a keyring parses key material. */
export function credentialCipher(env: Env): CredentialCipher {
  return new CredentialCipher(
    Keyring.fromEnv({
      CREDENTIAL_KEK_V1: env.CREDENTIAL_KEK_V1,
      CREDENTIAL_KEK_V2: env.CREDENTIAL_KEK_V2,
      CREDENTIAL_KEK_ACTIVE_VERSION: env.CREDENTIAL_KEK_ACTIVE_VERSION,
    }),
  );
}

/**
 * The AAD for a provider app secret.
 *
 * A platform-managed app has no organization or project, so those slots carry a constant.
 * They still have to be *something*: the AAD format is positional, and dropping fields for
 * one case would make the two kinds of record mutually undecryptable.
 */
function providerAppContext(app: ProviderApp) {
  return {
    organizationId: app.organizationId ?? 'platform',
    projectId: app.projectId ?? 'platform',
    connectionId: app.id,
    credentialType: 'client_secret',
  };
}

export interface ResolvedProviderApp {
  row: ProviderApp;
  credentials: ProviderAppCredentials;
}

/**
 * Resolve and decrypt the application for `provider`, or explain precisely why it is
 * unavailable.
 *
 * Returns null for strategies that need no registered application — Bluesky app passwords
 * and Telegram bot tokens — so those providers work with no configuration at all. That
 * split is why the product can ship every adapter before a single approval lands.
 */
export async function resolveProviderApp(
  db: Database,
  env: Env,
  provider: ProviderName,
  authStrategy: AuthStrategy,
  projectId: string,
  redirectUri: string,
): Promise<ResolvedProviderApp | null> {
  if (!requiresProviderApp(authStrategy)) return null;

  const row = await findProviderApp(db, provider, projectId);

  if (!row || row.disabledAt) {
    // Rule 14 — name the missing thing. "Provider unavailable" would send an integrator
    // to the status page for a problem only we can fix, in one row of one table.
    throw new ApiError('PROVIDER_NOT_CONFIGURED', {
      message:
        `${provider} is not yet available: no platform application credentials are configured ` +
        `for it. This is a platform-side setup step, not a problem with your request.`,
      param: 'provider',
    });
  }

  if (!row.clientId || !row.encryptedClientSecret) {
    throw new ApiError('PROVIDER_NOT_CONFIGURED', {
      message: `${provider} has an application record but no credentials stored against it.`,
      param: 'provider',
    });
  }

  const clientSecret = await credentialCipher(env).decrypt(
    {
      ciphertext: row.encryptedClientSecret.ciphertext,
      nonce: row.encryptedClientSecret.nonce,
      algorithm: row.encryptedClientSecret.algorithm as typeof CREDENTIAL_ALGORITHM,
      keyVersion: row.encryptedClientSecret.keyVersion,
    },
    providerAppContext(row),
  );

  return {
    row,
    credentials: {
      clientId: row.clientId,
      clientSecret,
      redirectUri,
      metadata: (row.callbackConfig ?? {}) as Record<string, unknown>,
    },
  };
}

/** The callback URL this deployment hands to providers. Must match what is registered. */
export function callbackUrlFor(origin: string, provider: ProviderName): string {
  return `${origin}/v1/oauth/${provider}/callback`;
}
