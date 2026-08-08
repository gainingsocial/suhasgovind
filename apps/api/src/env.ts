import type { DeploymentEnvironment } from '@gs/contracts/http';
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

  /** Uploaded and derived media (plan §6.5). Absent until R2 is enabled. */
  MEDIA?: R2Bucket;
}

/** Hono generic: bindings plus the per-request context the middleware installs. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    trace: TraceContext;
    logger: Logger;
  };
}
