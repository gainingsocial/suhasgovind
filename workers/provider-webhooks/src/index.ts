import {
  createDatabaseFromEnv,
  findProviderEventById,
  findUnprocessedProviderEvents,
  markProviderEventProcessed,
} from '@gs/db';
import { createLogger, newTraceContext, parseLogLevel } from '@gs/observability';

import type { Env, ProviderEventMessage } from './env.js';
import { handleIngress } from './ingress.js';
import { processProviderEvent } from './process-event.js';

/**
 * Inbound provider webhook ingress and processing (plan §34).
 *
 * One worker, two roles, deliberately not two workers: the ingress is the only thing that
 * knows how to verify a given provider's signature, and the processor is the only thing
 * that knows what its events mean. Splitting them would put the adapter registry in both.
 *
 * The contract with every provider is the same — verify, store, enqueue, acknowledge —
 * and nothing slow happens before the acknowledgment (plan §85 Rule 10).
 */

/** How long an enqueue may sit unprocessed before the sweeper picks it up. */
const SWEEP_AFTER_MINUTES = 15;

/** Bounded so a backlog cannot exceed the cron invocation's time budget. */
const SWEEP_LIMIT = 100;

export default {
  /**
   * The provider-facing endpoint.
   *
   * Acknowledges after the row is committed and before anything is processed. The enqueue
   * happens in `waitUntil`, so a slow queue cannot delay the response — and if the enqueue
   * is lost, the stored row is still there for the sweeper below. Enqueuing *before*
   * responding would trade a rare lost message for a routine slow acknowledgment, and the
   * slow acknowledgment is what causes redelivery storms.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const trace = newTraceContext();
    const logger = createLogger(trace, {
      service: 'provider-webhooks',
      level: parseLogLevel(env.LOG_LEVEL),
    });

    const handle = createDatabaseFromEnv(env);

    try {
      const outcome = await handleIngress(handle.db, env, request, logger, trace.traceId);

      if (outcome.enqueue.length > 0 && env.PROVIDER_EVENT_QUEUE) {
        const queue = env.PROVIDER_EVENT_QUEUE;
        ctx.waitUntil(
          Promise.all(outcome.enqueue.map((message) => queue.send(message))).catch((error) => {
            logger.error('provider_webhook.enqueue_failed', {
              count: outcome.enqueue.length,
              reason: error instanceof Error ? error.message : String(error),
            });
          }),
        );
      }

      return new Response(outcome.body, {
        status: outcome.status,
        headers: { 'content-type': outcome.contentType },
      });
    } catch (error) {
      logger.error('provider_webhook.ingress_crashed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      /**
       * 200 even on our own failure. A 5xx tells the provider to retry, and a bug here
       * would retry identically — converting one broken deploy into sustained inbound
       * traffic. The event is lost either way; the difference is whether we also spend the
       * incident absorbing a flood.
       */
      return new Response('', { status: 200 });
    } finally {
      ctx.waitUntil(handle.close());
    }
  },

  /** Processing, after the provider has already been told we have it. */
  async queue(
    batch: MessageBatch<ProviderEventMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const handle = createDatabaseFromEnv(env);

    try {
      for (const message of batch.messages) {
        const trace = newTraceContext({ traceId: message.body.traceId });
        const logger = createLogger(trace, {
          service: 'provider-webhooks',
          level: parseLogLevel(env.LOG_LEVEL),
        });

        try {
          const row = await findProviderEventById(handle.db, message.body.providerEventId);

          if (!row) {
            // Deleted by retention between enqueue and delivery. Nothing to do, and
            // retrying would never find it.
            message.ack();
            continue;
          }

          if (row.processedAt) {
            // At-least-once delivery of an event another attempt already handled (P4).
            message.ack();
            continue;
          }

          const result = await processProviderEvent(handle.db, row, logger);

          logger.info('provider_webhook.processed', {
            provider: row.provider,
            connections: result.affectedConnections,
            changed: result.changed,
          });

          message.ack();
        } catch (error) {
          logger.error('provider_webhook.process_crashed', {
            providerEventId: message.body.providerEventId,
            reason: error instanceof Error ? error.message : String(error),
          });
          // Retried by the queue. Processing is idempotent, so a duplicate run is safe
          // and a transient database failure should not silently drop a revocation.
          message.retry();
        }
      }
    } finally {
      await handle.close();
    }
  },

  /**
   * The safety net (plan §27, applied to ingress).
   *
   * The row lands before the enqueue, so a failed or lost enqueue leaves a verified event
   * stored and unprocessed. Without this sweep, a queue outage during a revocation storm
   * would leave every affected connection reporting healthy while none of them could
   * publish.
   */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const trace = newTraceContext();
    const logger = createLogger(trace, {
      service: 'provider-webhooks',
      level: parseLogLevel(env.LOG_LEVEL),
    });

    const handle = createDatabaseFromEnv(env);

    try {
      const stale = await findUnprocessedProviderEvents(handle.db, {
        olderThan: new Date(Date.now() - SWEEP_AFTER_MINUTES * 60_000),
        limit: SWEEP_LIMIT,
      });

      if (stale.length === 0) return;

      logger.warn('provider_webhook.sweeping', { count: stale.length });

      for (const row of stale) {
        try {
          await processProviderEvent(handle.db, row, logger);
        } catch (error) {
          // Recorded on the row and closed out. A payload that fails deterministically
          // fails identically on every sweep, and leaving it open would make the sweeper
          // retry it forever at the expense of events that can still succeed.
          await markProviderEventProcessed(
            handle.db,
            row.id,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      await handle.close();
    }
  },
};
