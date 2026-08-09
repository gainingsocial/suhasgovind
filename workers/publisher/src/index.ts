import { createDatabaseFromEnv } from '@gs/db';
import { createLogger, newTraceContext, parseLogLevel } from '@gs/observability';

import type { Env, PublishMessage } from './env.js';
import { executeTarget } from './execute-target.js';
import { pollTargetStatus } from './poll-status.js';
import { reconcileTarget } from './reconcile.js';

export { RateLimiter } from './rate-limiter.js';

/**
 * Publish queue consumer (plan §6.2, §24.3).
 *
 * Every message is safe to process twice (P4). The guarantee does not come from the queue
 * — Cloudflare Queues are at-least-once by design — it comes from the target lease: a
 * message grants the right to *try*, and only the conditional UPDATE grants the right to
 * publish.
 *
 * Messages are acknowledged individually rather than as a batch. A batch ack would retry
 * nine successful targets to redeliver one failure, and each of those nine would then
 * have to be rejected by the lease. Correct, but wasteful and much harder to read in the
 * logs.
 */
export default {
  async queue(batch: MessageBatch<PublishMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    const handle = createDatabaseFromEnv(env);

    try {
      // Sequential, not parallel. Concurrency here would multiply against the queue's own
      // batch concurrency and against every other isolate, which is precisely the
      // uncoordinated load the rate limiter exists to prevent.
      for (const message of batch.messages) {
        const body = message.body;
        const trace = newTraceContext({ traceId: body.traceId });
        const logger = createLogger(trace, {
          service: 'publisher',
          level: parseLogLevel(env.LOG_LEVEL),
        });

        try {
          switch (body.type) {
            case 'publish.target': {
              const result = await executeTarget(handle.db, env, body, logger);
              logger.info('publish.target.done', {
                postTargetId: body.postTargetId,
                outcome: result.outcome,
                reason: result.reason,
              });
              break;
            }
            case 'publish.poll_status': {
              const outcome = await pollTargetStatus(handle.db, env, body, logger);
              logger.info('publish.poll.done', { postTargetId: body.postTargetId, outcome });
              break;
            }
            case 'publish.reconcile': {
              const outcome = await reconcileTarget(handle.db, env, body, logger);
              logger.info('publish.reconcile.done', { postTargetId: body.postTargetId, outcome });
              break;
            }
          }

          message.ack();
        } catch (error) {
          // An unexpected throw. Retry the message: the lease makes that safe, and the
          // alternative — acking a message whose work did not happen — silently drops a
          // customer's post.
          logger.error('publish.message.failed', {
            type: body.type,
            postTargetId: 'postTargetId' in body ? body.postTargetId : undefined,
            reason: error instanceof Error ? error.message : String(error),
          });
          message.retry();
        }
      }
    } finally {
      ctx.waitUntil(handle.close());
    }
  },
};
