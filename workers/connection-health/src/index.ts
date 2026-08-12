import { createDatabaseFromEnv, findConnectionsDueForRefresh } from '@gs/db';
import { createLogger, newTraceContext, parseLogLevel } from '@gs/observability';

import type { Env } from './env.js';
import { refreshConnection, type RefreshOutcome } from './refresh.js';

/**
 * The connection health engine (plan §42).
 *
 * One job: keep credentials working, and say so clearly when they cannot be kept working.
 *
 * Everything a customer experiences as "it just stopped posting" starts here. A token that
 * expires unnoticed produces a failed publish, and a failed publish is the worst possible
 * place to learn about it — the post is late, the customer finds out from the absence of
 * it, and the only remaining options are a delayed retry or an apology.
 */

/**
 * How far ahead of expiry to refresh.
 *
 * Long enough that a provider outage lasting hours still leaves several sweeps to succeed
 * in before anything actually expires. Short enough that we are not refreshing tokens with
 * most of their life left, which on providers that rotate would churn credentials for no
 * reason.
 */
const REFRESH_WINDOW_SECONDS = 24 * 3600;

/**
 * Connections per run.
 *
 * Bounded because each one is a provider call inside a cron invocation's time budget. Rows
 * come back most-urgent-first, so a truncated batch leaves behind what has the most time
 * left, and the next sweep picks it up.
 */
const BATCH_LIMIT = 50;

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const trace = newTraceContext();
    const logger = createLogger(trace, {
      service: 'connection-health',
      level: parseLogLevel(env.LOG_LEVEL),
    });

    const handle = createDatabaseFromEnv(env);
    const startedAt = Date.now();

    try {
      const due = await findConnectionsDueForRefresh(handle.db, REFRESH_WINDOW_SECONDS, BATCH_LIMIT);
      if (due.length === 0) return;

      const tally: Partial<Record<RefreshOutcome | 'crashed', number>> = {};

      /**
       * Sequential, not `Promise.all`.
       *
       * Fifty concurrent refreshes against one provider is a burst that provider will rate
       * limit, and being rate limited on the *refresh* endpoint is how a maintenance sweep
       * turns into an outage. The lock also means concurrency buys nothing when several
       * rows belong to the same connection.
       */
      for (const row of due) {
        try {
          const outcome = await refreshConnection(handle.db, env, row, logger);
          tally[outcome] = (tally[outcome] ?? 0) + 1;
        } catch (error) {
          // One connection must not stop the sweep. The rest still have expiring tokens,
          // and skipping them because of an unrelated failure is how a single bad row
          // takes an entire customer base offline.
          tally.crashed = (tally.crashed ?? 0) + 1;
          logger.error('connection_health.refresh_crashed', {
            connectionId: row.connectionId,
            provider: row.provider,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info('connection_health.completed', {
        examined: due.length,
        ...tally,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger.error('connection_health.sweep_failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      ctx.waitUntil(handle.close());
    }
  },
};
