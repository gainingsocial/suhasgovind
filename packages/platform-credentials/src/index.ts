import { requiresProviderApp, type AuthStrategy, type ProviderName } from '@gs/contracts/providers';
import { CredentialCipher, Keyring, type CREDENTIAL_ALGORITHM } from '@gs/crypto';
import { findProviderApp, type Database, type ProviderApp } from '@gs/db';
import type { ProviderAppCredentials } from '@gs/provider-kit';

/**
 * Resolving and decrypting a registered platform application (plan §23, P9).
 *
 * One implementation, shared by the API, the publisher and the webhook ingress.
 *
 * It lives in its own package because the associated data below is a correctness contract
 * between whoever encrypts and everyone who decrypts. When this logic was copied per
 * caller, the AAD was reconstructed by hand in each — and an AAD that drifts by one field
 * does not degrade, it makes every existing secret permanently undecryptable. Having a
 * single definition is what makes that class of bug impossible rather than unlikely.
 */

/**
 * The associated data binding a client secret to the row it belongs to.
 *
 * A platform-managed app belongs to no tenant, so those slots carry the constant
 * `'platform'` rather than being omitted. The AAD is positional: dropping a field for one
 * ownership model would make platform-managed and customer-managed secrets mutually
 * undecryptable.
 */
export function providerAppCredentialContext(app: Pick<ProviderApp, 'id' | 'organizationId' | 'projectId'>) {
  return {
    organizationId: app.organizationId ?? 'platform',
    projectId: app.projectId ?? 'platform',
    connectionId: app.id,
    credentialType: 'client_secret',
  };
}

/**
 * Key material as every runtime supplies it — a Worker `Env`, a test fixture, or the CLI.
 *
 * A type alias rather than an interface, deliberately: TypeScript gives an alias an
 * implicit index signature, which is what lets a whole Worker `Env` — bindings, queues and
 * all — be passed straight through to `Keyring.fromEnv`. An interface here would force
 * every caller to hand-pick the three fields, and hand-picking is how a rotation's third
 * KEK version gets left behind.
 */
export type CredentialKeyEnv = {
  CREDENTIAL_KEK_V1?: string;
  CREDENTIAL_KEK_V2?: string;
  CREDENTIAL_KEK_ACTIVE_VERSION?: string;
};

/** Built per call that needs it; constructing a keyring parses key material. */
export function credentialCipher(env: CredentialKeyEnv): CredentialCipher {
  return new CredentialCipher(Keyring.fromEnv(env));
}

export type ProviderAppResolution =
  /** This strategy needs no registered application — Bluesky, Telegram, Discord. */
  | { kind: 'not_required' }
  /** Resolved and decrypted, ready to hand to an adapter. */
  | { kind: 'resolved'; row: ProviderApp; credentials: ProviderAppCredentials }
  /**
   * Needed but unusable. Returned rather than thrown so each caller can react in the way
   * that suits it: the API turns this into `PROVIDER_NOT_CONFIGURED`, the publisher blocks
   * the target with a precise reason, and the webhook ingress acknowledges and drops.
   */
  | { kind: 'unavailable'; reason: 'no_app' | 'no_credentials' | 'disabled'; message: string };

export interface ResolveProviderAppInput {
  provider: ProviderName | string;
  authStrategy: AuthStrategy;
  /** `null` resolves the shared platform default without considering a customer app. */
  projectId: string | null;
  /** Must match what is registered in the provider's developer console. */
  redirectUri: string;
  env: CredentialKeyEnv;
}

/**
 * Resolve the application for a provider call, decrypting its secret.
 *
 * Resolved per call rather than cached. The entire point of keeping platform credentials
 * in a table is that a rotated secret or a newly approved platform takes effect without a
 * deploy (plan §23) — a cache would reintroduce the restart that removes.
 *
 * The decrypted secret is returned to the caller and must not outlive the call that needs
 * it: never logged, never persisted, never returned from an endpoint (P9, §7.2).
 */
export async function resolveProviderApp(
  db: Database,
  input: ResolveProviderAppInput,
): Promise<ProviderAppResolution> {
  if (!requiresProviderApp(input.authStrategy)) return { kind: 'not_required' };

  const row = await findProviderApp(db, input.provider, input.projectId);

  if (!row) {
    return {
      kind: 'unavailable',
      reason: 'no_app',
      // Rule 14 — name the missing thing. "Provider unavailable" would send an integrator
      // to a status page for a problem only we can fix, in one row of one table.
      message:
        `${input.provider} is not yet available: no platform application credentials are ` +
        `configured for it. This is a platform-side setup step, not a problem with the request.`,
    };
  }

  if (row.disabledAt) {
    return {
      kind: 'unavailable',
      reason: 'disabled',
      message: `The ${input.provider} platform application is disabled.`,
    };
  }

  if (!row.clientId || !row.encryptedClientSecret) {
    return {
      kind: 'unavailable',
      reason: 'no_credentials',
      message: `${input.provider} has an application record but no credentials stored against it.`,
    };
  }

  const clientSecret = await credentialCipher(input.env).decrypt(
    {
      ciphertext: row.encryptedClientSecret.ciphertext,
      nonce: row.encryptedClientSecret.nonce,
      // The column is text; the cipher rejects anything it does not recognize, so a
      // mismatched value fails loudly at decryption rather than being assumed correct.
      algorithm: row.encryptedClientSecret.algorithm as typeof CREDENTIAL_ALGORITHM,
      keyVersion: row.encryptedClientSecret.keyVersion,
    },
    providerAppCredentialContext(row),
  );

  return {
    kind: 'resolved',
    row,
    credentials: {
      clientId: row.clientId,
      clientSecret,
      redirectUri: input.redirectUri,
      metadata: (row.callbackConfig ?? {}) as Record<string, unknown>,
    },
  };
}

/** The callback URL this deployment hands to providers. Must match what is registered. */
export function callbackUrlFor(origin: string, provider: ProviderName | string): string {
  return `${origin}/v1/oauth/${provider}/callback`;
}

/**
 * The webhook URL this deployment registers with a provider.
 *
 * Takes its own origin rather than reusing the API's. The ingress runs as a separate
 * Worker on a separate hostname — `api.gainingsocial.com` is a Custom Domain, which claims
 * an entire hostname and leaves no room for a second Worker on a subpath — so deriving
 * this from the API origin would print a URL that resolves to the API and 404s.
 *
 * Unversioned on purpose: the URL is typed into a developer console and stays there for
 * years, so pinning it to `/v1` would mean an API version bump silently stops a provider
 * from reaching us, and a webhook that stops arriving reports no error anywhere.
 */
export function webhookUrlFor(webhookOrigin: string, provider: ProviderName | string): string {
  return `${webhookOrigin}/webhooks/providers/${provider}`;
}
