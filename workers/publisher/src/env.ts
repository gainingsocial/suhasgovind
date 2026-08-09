import type { Logger, TraceContext } from '@gs/observability';

/**
 * Publisher worker bindings.
 *
 * Deliberately narrower than the API's: this worker never serves a request, so it has no
 * KV for idempotency and no R2 presigning credentials. It reads media through short-lived
 * signed URLs it mints from the same R2 credentials, and everything else it needs comes
 * from the database.
 */
export interface Env {
  ENVIRONMENT: 'test' | 'live';
  SERVICE_VERSION: string;
  LOG_LEVEL: string;

  /** Pooled Postgres (ADR-003). */
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;

  /** Root KEK for decrypting provider credentials (plan §7.1). */
  CREDENTIAL_KEK_V1?: string;
  CREDENTIAL_KEK_V2?: string;
  CREDENTIAL_KEK_ACTIVE_VERSION?: string;

  /** Re-enqueue for delayed retries, and hand webhook events to the delivery worker. */
  PUBLISH_QUEUE?: Queue;
  WEBHOOK_QUEUE?: Queue;

  /** Cross-isolate rate-limit coordination (plan §29). */
  RATE_LIMITER?: DurableObjectNamespace;

  /** Signed reads for media the provider must fetch. */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
}

/** One publish-queue message: one target, one attempt. */
export interface PublishTargetMessage {
  type: 'publish.target';
  postId: string;
  postTargetId: string;
  traceId?: string;
}

/** Poll a provider that accepted the post but is still processing it. */
export interface PollStatusMessage {
  type: 'publish.poll_status';
  postId: string;
  postTargetId: string;
  traceId?: string;
}

/** Resolve an ambiguous outcome before anything is retried (ADR-006 Layer 4). */
export interface ReconcileMessage {
  type: 'publish.reconcile';
  postId: string;
  postTargetId: string;
  traceId?: string;
}

/**
 * Fan a scheduled post out to its targets.
 *
 * Sent by the reconciler when a post's time has arrived. It exists because the delayed
 * message the publish path sends can be lost, and because Cloudflare Queues cap how far
 * ahead a message may be delayed — a post scheduled for next month cannot be represented
 * as a delayed message at all.
 */
export interface ScheduledPostMessage {
  type: 'publish.scheduled_post';
  postId: string;
  traceId?: string;
}

export type PublishMessage =
  | PublishTargetMessage
  | PollStatusMessage
  | ReconcileMessage
  | ScheduledPostMessage;

export interface WorkerContext {
  logger: Logger;
  trace: TraceContext;
}
