import type { AuthenticatedPrincipal } from '@gs/auth';
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

  /** Uploaded and derived media (plan §6.5). Absent until R2 is enabled. */
  MEDIA?: R2Bucket;
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
  };
}
