/**
 * Connection health worker bindings (plan §42).
 *
 * It needs credentials (to refresh them), the registry (to know how), and the webhook
 * queue (to say so when it cannot). It has no publish queue and no R2, because nothing it
 * does publishes anything.
 */
export interface Env {
  ENVIRONMENT: 'test' | 'live';
  SERVICE_VERSION: string;
  LOG_LEVEL: string;

  /** Pooled Postgres (ADR-003). */
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;

  /** Decrypts the credential being refreshed and encrypts what replaces it (plan §7.1). */
  CREDENTIAL_KEK_V1?: string;
  CREDENTIAL_KEK_V2?: string;
  CREDENTIAL_KEK_ACTIVE_VERSION?: string;

  /** Carries `connection.reauth_required` to the customer. */
  WEBHOOK_QUEUE?: Queue;

  /**
   * Reconstructs the OAuth redirect URI, which some providers validate on refresh. A wrong
   * value fails the refresh rather than being ignored.
   */
  PUBLIC_API_ORIGIN?: string;
}
