import {
  createDatabaseFromEnv,
  expireAbandonedUploads,
  findAbandonedTargets,
  findOverdueScheduledPosts,
  findDueDeliveries,
  purgeExpiredIdempotencyKeys,
  releaseTargetLease,
  type Database,
} from '@gs/db';
import { createLogger, newTraceContext, parseLogLevel } from '@gs/observability';

/**
 * The safety net (plan §27, §85 Rule 10).
 *
 * Everything here exists because the happy path can be interrupted. A Worker can die
 * mid-publish, a queue message can be lost, a scheduled post's delayed message can fail to
 * materialize. None of those are hypothetical at scale, and every one of them ends with a
 * customer's post silently never going out — the worst failure this product has, because
 * nothing surfaces it.
 *
 * The cron is therefore not an optimization. It is the thing that makes "scheduled" mean
 * anything: without it, a post scheduled for next Tuesday sits in the database forever.
 *
 * Every sweep is idempotent. Running twice must be harmless, because a cron that overlaps
 * its own previous run is normal (P4).
 */

export interface Env {
  ENVIRONMENT: 'test' | 'live';
  SERVICE_VERSION: string;
  LOG_LEVEL: string;

  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;

  PUBLISH_QUEUE?: Queue;
  WEBHOOK_QUEUE?: Queue;
}

/** Bounded per run. A sweep that tries to fix everything at once starves the next one. */
const BATCH_LIMIT = 200;

/**
 * Enqueue scheduled posts whose time has arrived.
 *
 * The publish path already schedules a delayed queue message, so in the normal case this
 * finds nothing. It matters for the abnormal case: a post scheduled beyond the queue's
 * maximum delay, a message dropped during a platform incident, or a post whose schedule
 * was edited after the original message was sent.
 */
async function sweepScheduledPosts(db: Database, env: Env, log: ReturnType<typeof createLogger>) {
  const overdue = await findOverdueScheduledPosts(db, { limit: BATCH_LIMIT });
  if (overdue.length === 0) return 0;

  for (const post of overdue) {
    // Re-enqueueing an already-queued target is safe: the lease decides who publishes, so
    // a duplicate message is refused rather than acted on.
    if (env.PUBLISH_QUEUE) {
      await env.PUBLISH_QUEUE.send({
        type: 'publish.scheduled_post',
        postId: post.id,
        traceId: `trc_reconciler_${post.id}`,
      });
    }
  }

  log.warn('reconciler.scheduled_posts_swept', { count: overdue.length });
  return overdue.length;
}

/**
 * Recover targets whose worker died mid-publish.
 *
 * A lease that has expired while still in `publishing` means the holder never finished.
 * Releasing it returns the target to `queued` so another worker can take over.
 *
 * Note what this deliberately does NOT do: it does not assume the publish failed. The
 * target goes back through the normal path, where the lease and the content fingerprint
 * still apply — and if the provider did receive the post, reconciliation catches it rather
 * than this sweep guessing.
 */
async function sweepAbandonedLeases(db: Database, env: Env, log: ReturnType<typeof createLogger>) {
  const abandoned = await findAbandonedTargets(db, { limit: BATCH_LIMIT });
  if (abandoned.length === 0) return 0;

  for (const target of abandoned) {
    if (!target.leaseId) continue;

    await releaseTargetLease(db, {
      targetId: target.id,
      leaseId: target.leaseId,
      retryAt: new Date(),
    });

    if (env.PUBLISH_QUEUE) {
      await env.PUBLISH_QUEUE.send({
        type: 'publish.target',
        postId: target.postId,
        postTargetId: target.id,
        traceId: `trc_reconciler_${target.id}`,
      });
    }
  }

  // Worth a warning rather than an info: a healthy system produces none of these, so a
  // steady trickle means workers are dying and someone should know.
  log.warn('reconciler.abandoned_leases_recovered', { count: abandoned.length });
  return abandoned.length;
}

/** Re-drive webhook deliveries whose retry time has passed but whose message went missing. */
async function sweepDueDeliveries(db: Database, env: Env, log: ReturnType<typeof createLogger>) {
  const due = await findDueDeliveries(db, BATCH_LIMIT);
  if (due.length === 0) return 0;

  for (const delivery of due) {
    if (env.WEBHOOK_QUEUE) {
      await env.WEBHOOK_QUEUE.send({
        type: 'webhook.deliver',
        deliveryId: delivery.id,
        traceId: `trc_reconciler_${delivery.id}`,
      });
    }
  }

  log.info('reconciler.deliveries_swept', { count: due.length });
  return due.length;
}

/**
 * Housekeeping.
 *
 * Idempotency keys and abandoned upload reservations both accumulate forever otherwise —
 * a client that asks for a presigned URL and never uploads leaves a row behind every time.
 */
async function sweepExpired(db: Database, log: ReturnType<typeof createLogger>) {
  const [keys, uploads] = await Promise.all([
    purgeExpiredIdempotencyKeys(db),
    expireAbandonedUploads(db),
  ]);

  if (keys > 0 || uploads > 0) {
    log.info('reconciler.expired_swept', { idempotencyKeys: keys, uploads });
  }
  return keys + uploads;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const trace = newTraceContext();
    const log = createLogger(trace, { service: 'reconciler', level: parseLogLevel(env.LOG_LEVEL) });
    const handle = createDatabaseFromEnv(env);
    const startedAt = Date.now();

    try {
      // Sequential and independently guarded: one sweep failing must not stop the others.
      // A broken webhook sweep should never prevent scheduled posts from firing.
      const results: Record<string, number | string> = {};

      for (const [name, sweep] of [
        ['scheduledPosts', () => sweepScheduledPosts(handle.db, env, log)],
        ['abandonedLeases', () => sweepAbandonedLeases(handle.db, env, log)],
        ['dueDeliveries', () => sweepDueDeliveries(handle.db, env, log)],
        ['expired', () => sweepExpired(handle.db, log)],
      ] as const) {
        try {
          results[name] = await sweep();
        } catch (error) {
          results[name] = 'failed';
          log.error('reconciler.sweep_failed', {
            sweep: name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      log.info('reconciler.completed', { ...results, durationMs: Date.now() - startedAt });
    } finally {
      ctx.waitUntil(handle.close());
    }
  },
};
