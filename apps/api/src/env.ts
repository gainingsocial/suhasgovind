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
