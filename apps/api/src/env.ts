import type { AuthenticatedPrincipal, DashboardUser } from '@gs/auth';
import type { DeploymentEnvironment } from '@gs/contracts/http';
import type { Database } from '@gs/db';
import type { Logger, TraceContext } from '@gs/observability';

/**
 * Worker bindings (plan §6).
 *
 * Bindings for infrastructure that is provisioned but not yet consumed are declared
 * optional rather than omitted. A binding that appears later is then picked up without a
 * code change, and code that needs one can fail with a useful error (Rule 14) instead of
 * dereferencing `undefined`.
 */
export interface Env {
  /** Which environment kind this deploy serves. Drives nothing security-sensitive. */
  ENVIRONMENT: DeploymentEnvironment;
  /** Build identifier surfaced by the health route. */
  SERVICE_VERSION: string;
  LOG_LEVEL: string;

  /** Idempotency keys and short-lived response caching (plan §6.1). */
  IDEMPOTENCY?: KVNamespace;

  /** Per-target publishing and webhook egress (plan §6.2). */
  PUBLISH_QUEUE?: Queue;
  WEBHOOK_QUEUE?: Queue;

  /** Pooled Supabase Postgres (plan §5.2, ADR-003). Absent until Hyperdrive exists. */
  HYPERDRIVE?: Hyperdrive;
  /** Direct connection string, used only where Hyperdrive is not bound. */
  DATABASE_URL?: string;

  /**
   * Keyed-hash pepper for API keys (plan §38). A Worker Secret, never a `var` — a `var`
   * lives in wrangler.jsonc and would be committed.
   */
  API_KEY_HASH_PEPPER?: string;

  /** Uploaded and derived media (plan §6.5). */
  MEDIA?: R2Bucket;
  /** Metadata probe queue. Probing never runs in the request path (Rule 10). */
  MEDIA_QUEUE?: Queue;

  /**
   * R2 S3 credentials for presigned uploads (plan §31).
   *
   * Separate from the MEDIA binding on purpose: a binding lets the Worker read and write
   * objects itself, which would mean streaming every upload through the Worker. These
   * sign a URL the client uses directly. Worker Secrets, never vars.
   */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;

  /** Root the per-endpoint webhook signing secrets derive from (plan §36, ADR-007). */
  WEBHOOK_SIGNING_ROOT?: string;

  /**
   * Key-encryption keys for provider credentials (plan §7.1, ADR-007). Versioned from day
   * one so a rotation reads the old version while writing the new. Worker Secrets.
   */
  CREDENTIAL_KEK_V1?: string;
  CREDENTIAL_KEK_V2?: string;
  CREDENTIAL_KEK_ACTIVE_VERSION?: string;

  /**
   * Signs hosted connect session tokens (plan §22). The token is handed to a customer's
   * end user, who is not authenticated with us at all, so the signature is the only thing
   * standing between a guessed URL and somebody else's connect flow.
   */
  CONNECT_SESSION_SIGNING_KEY?: string;

  /**
   * Public origin of this API, used to build the provider callback URL registered with
   * each platform. Derived from the request when unset, which is correct in development
   * and wrong the moment a proxy sits in front — so production sets it explicitly.
   */
  PUBLIC_API_ORIGIN?: string;

  /**
   * Where providers deliver webhooks (plan §34).
   *
   * A separate hostname from the API, because `api.gainingsocial.com` is a Custom Domain
   * and a Custom Domain claims the whole hostname — the ingress Worker cannot live on a
   * subpath of it. Shown on the Platforms page for an operator to register.
   */
  PUBLIC_WEBHOOK_ORIGIN?: string;

  /**
   * Comma-separated user ids permitted to write the shared platform application
   * (plan §23). Authority over the platform itself, so it lives in the platform's own
   * configuration — a database row granting it would be a row somebody could write.
   */
  PLATFORM_OPERATOR_USER_IDS?: string;

  /**
   * Supabase project URL, used to fetch the public JWKS that verifies dashboard sessions
   * (plan §39). Not a secret — it is a public discovery endpoint.
   */
  SUPABASE_URL?: string;
}

/** Hono generic: bindings plus the per-request context the middleware installs. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    trace: TraceContext;
    logger: Logger;
    /** Set by the authenticate middleware; absent on public routes. */
    principal: AuthenticatedPrincipal;
    /** Set by the withDatabase middleware; absent on routes that need no database. */
    db: Database;
    /** Set by authenticateHuman; absent on machine-authenticated routes. */
    user: DashboardUser;
  };
}
