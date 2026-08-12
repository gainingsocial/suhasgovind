import type { AuthStrategy, ProviderName } from '@gs/contracts/providers';
import type { CredentialCipher } from '@gs/crypto';
import type { Database } from '@gs/db';
import { ApiError } from '@gs/errors';
import {
  callbackUrlFor,
  credentialCipher as buildCredentialCipher,
  resolveProviderApp as resolvePlatformApp,
  type ProviderAppResolution,
} from '@gs/platform-credentials';
import type { ProviderAppCredentials } from '@gs/provider-kit';
import type { ProviderApp } from '@gs/db';

import type { Env } from '../env.js';

/**
 * Resolving the registered platform application for a provider call (plan §23).
 *
 * This is the mechanism that makes a granted platform approval a data change rather than
 * a deploy: the client id and secret live in `provider_apps`, are resolved at call time,
 * and prefer a customer's own application over the shared platform default.
 *
 * The resolution and decryption themselves live in `@gs/platform-credentials`, shared with
 * the publisher and the webhook ingress. What stays here is the API's reaction to an
 * unusable application: an `ApiError` an integrator can act on.
 *
 * The secret is decrypted and handed straight to the adapter (P9, §7.2). It is never
 * logged, never returned from an endpoint, and never held beyond the call that needs it.
 */

/** Built once per request that needs it; constructing a keyring parses key material. */
export function credentialCipher(env: Env): CredentialCipher {
  return buildCredentialCipher(env);
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
  const resolution: ProviderAppResolution = await resolvePlatformApp(db, {
    provider,
    authStrategy,
    projectId,
    redirectUri,
    env,
  });

  if (resolution.kind === 'not_required') return null;

  if (resolution.kind === 'unavailable') {
    throw new ApiError('PROVIDER_NOT_CONFIGURED', {
      message: resolution.message,
      param: 'provider',
    });
  }

  return { row: resolution.row, credentials: resolution.credentials };
}

export { callbackUrlFor };
