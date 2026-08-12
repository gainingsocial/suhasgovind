import { toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import {
  finishPublishAttempt,
  leaseTargetForExecution,
  markTargetPermanentFailure,
  markTargetProviderProcessing,
  recordPreparedProviderIds,
  markTargetPublished,
  markTargetReconciliationRequired,
  markTargetRetryableFailure,
  recalculatePostStatus,
  releaseTargetLease,
  startPublishAttempt,
  type Database,
  type PostTarget,
} from '@gs/db';
import { dispositionFor, isRetryable, providerErrorMetadata } from '@gs/errors';
import { getAdapter, hasAdapter } from '@gs/providers';
import type { NormalizedProviderError } from '@gs/errors';
import type { Logger } from '@gs/observability';

import type { Env, PublishTargetMessage } from './env.js';
import { RateLimiterClient } from './rate-limiter.js';
import { loadPublishContext } from './load-context.js';
import { providerContext } from './provider-context.js';

/**
 * Execute one publish target (plan §24.3).
 *
 * The order of the steps is not arbitrary. Each one is a gate that must close before the
 * next opens, and the sequence is what makes at-least-once queue delivery safe:
 *
 *   1. lease          only the winner may publish (ADR-006 Layer 2)
 *   2. load context   destination, connection, credentials, content
 *   3. permit         ask the rate limiter before touching the provider (§29)
 *   4. attempt record opened BEFORE the call, so a crash still leaves evidence
 *   5. prepare        upload media, open containers
 *   6. publish        the single irreversible act
 *   7. classify       map the outcome onto the shared taxonomy
 *
 * A queue message does not grant the right to publish. Winning the lease does. That
 * distinction is the whole reason redelivery is safe.
 */

/** How long a worker may hold a target before another may take over. */
const LEASE_SECONDS = 300;

/** Per-call budget for the provider. Well under the lease, so a hung call frees the lease. */
const PROVIDER_TIMEOUT_MS = 45_000;

export interface ExecuteResult {
  outcome:
    | 'published'
    | 'processing'
    | 'retryable_failed'
    | 'permanent_failed'
    | 'reconciliation_required'
    | 'skipped';
  reason?: string;
}

/**
 * Backoff for a retryable failure.
 *
 * Exponential with full jitter. The jitter matters more than the curve: without it, a
 * provider outage that fails a thousand targets at once produces a thundering herd
 * retrying in perfect lockstep, which is how a recovering provider gets knocked over
 * again.
 */
function nextAttemptDelayMs(attemptNumber: number): number {
  const base = Math.min(30_000 * 2 ** Math.max(attemptNumber - 1, 0), 6 * 60 * 60 * 1000);
  return Math.floor(Math.random() * base);
}

export async function executeTarget(
  db: Database,
  env: Env,
  message: PublishTargetMessage,
  logger: Logger,
): Promise<ExecuteResult> {
  // ---- 1. lease ------------------------------------------------------------
  const lease = await leaseTargetForExecution(db, {
    targetId: message.postTargetId,
    leaseSeconds: LEASE_SECONDS,
  });

  if (!lease.acquired || !lease.target || !lease.leaseId) {
    // Another worker owns it, it is already terminal, or it has exhausted its attempts.
    // Acknowledge and exit WITHOUT publishing — this is the branch that prevents
    // duplicates under redelivery, so it must never fall through to a provider call.
    logger.info('target.lease_not_acquired', { postTargetId: message.postTargetId });
    return { outcome: 'skipped', reason: 'lease_not_acquired' };
  }

  const target: PostTarget = lease.target;
  const leaseId = lease.leaseId;
  const attemptNumber = target.attemptCount;

  const fail = async (
    error: NormalizedProviderError,
    attemptId: string | null,
    startedAt: number,
  ): Promise<ExecuteResult> => {
    const disposition = dispositionFor(error);
    const meta = providerErrorMetadata(error.code);

    if (attemptId) {
      await finishPublishAttempt(db, {
        attemptId,
        outcome:
          disposition === 'unknown_reconciliation_required'
            ? 'unknown_reconciliation_required'
            : disposition === 'permanent_failed' || disposition === 'blocked_on_connection'
              ? 'permanent_failed'
              : 'retryable_failed',
        errorCode: error.code,
        errorMessage: error.message,
        providerErrorSubcode: error.subcode ?? null,
        providerStatus: error.status ?? null,
        durationMs: Date.now() - startedAt,
      });
    }

    if (disposition === 'unknown_reconciliation_required') {
      // The single most important branch in the engine. We cannot tell whether the post
      // was created, so we do NOT retry — reconciliation runs first (ADR-006 Layer 4).
      await markTargetReconciliationRequired(db, {
        targetId: target.id,
        leaseId,
        errorCode: error.code,
        errorMessage: error.message,
      });

      if (env.PUBLISH_QUEUE) {
        await env.PUBLISH_QUEUE.send(
          { type: 'publish.reconcile', postId: target.postId, postTargetId: target.id, traceId: message.traceId },
          // A short delay: a provider that timed out may still be writing the post, and
          // asking immediately can see a state that has not settled.
          { delaySeconds: 30 },
        );
      }

      await recalculatePostStatus(db, target.postId);
      return { outcome: 'reconciliation_required', reason: error.code };
    }

    if (!isRetryable(error) || disposition === 'permanent_failed' || disposition === 'blocked_on_connection') {
      await markTargetPermanentFailure(db, {
        targetId: target.id,
        leaseId,
        errorCode: error.code,
        errorMessage: error.message,
      });
      await recalculatePostStatus(db, target.postId);
      return { outcome: 'permanent_failed', reason: error.code };
    }

    // Honour the provider's own retry time when it gave one; a schedule we invented is
    // strictly worse information than the one the provider published.
    const retryAt = error.retryAfter
      ? new Date(error.retryAfter)
      : new Date(Date.now() + nextAttemptDelayMs(attemptNumber));

    await markTargetRetryableFailure(db, {
      targetId: target.id,
      leaseId,
      errorCode: error.code,
      errorMessage: error.message,
      nextAttemptAt: retryAt,
    });

    if (env.PUBLISH_QUEUE) {
      await env.PUBLISH_QUEUE.send(
        { type: 'publish.target', postId: target.postId, postTargetId: target.id, traceId: message.traceId },
        { delaySeconds: Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000)) },
      );
    }

    await recalculatePostStatus(db, target.postId);
    logger.warn('target.retryable_failure', {
      postTargetId: target.id,
      code: error.code,
      severity: meta.severity,
      retryAt: retryAt.toISOString(),
    });
    return { outcome: 'retryable_failed', reason: error.code };
  };

  // ---- 2. context ----------------------------------------------------------
  if (!isProviderName(target.provider) || !hasAdapter(target.provider)) {
    await markTargetPermanentFailure(db, {
      targetId: target.id,
      leaseId,
      errorCode: 'PROVIDER_NOT_SUPPORTED',
      errorMessage: `No adapter is registered for "${target.provider}".`,
    });
    await recalculatePostStatus(db, target.postId);
    return { outcome: 'permanent_failed', reason: 'PROVIDER_NOT_SUPPORTED' };
  }

  const adapter = getAdapter(target.provider);
  const startedAt = Date.now();

  let context;
  try {
    context = await loadPublishContext(db, env, target);
  } catch (error) {
    const normalized = adapter.normalizeError(error, {
      operation: 'loadContext',
      provider: target.provider,
    });
    return fail(normalized, null, startedAt);
  }

  if (context.blocked) {
    /**
     * A block expected to clear — a provider kill switch (plan §45) — goes back on the
     * queue rather than failing. Permanently failing every post in flight would turn a
     * five-minute mitigation into a day of support tickets and manual retries.
     *
     * Handled here rather than through `fail`, because `fail` speaks the normalized
     * *provider* taxonomy (plan §79) and this is not a provider failure. Nothing was
     * attempted and no provider was contacted; putting our own kill switch into that
     * taxonomy would corrupt the provider error rates the health engine reads.
     */
    if (context.blocked.retryable) {
      const retryAt = new Date(Date.now() + nextAttemptDelayMs(attemptNumber));

      await markTargetRetryableFailure(db, {
        targetId: target.id,
        leaseId,
        errorCode: context.blocked.code,
        errorMessage: context.blocked.message,
        nextAttemptAt: retryAt,
      });

      if (env.PUBLISH_QUEUE) {
        await env.PUBLISH_QUEUE.send(
          {
            type: 'publish.target',
            postId: target.postId,
            postTargetId: target.id,
            traceId: message.traceId,
          },
          { delaySeconds: Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000)) },
        );
      }

      await recalculatePostStatus(db, target.postId);
      logger.warn('target.blocked_retryable', {
        postTargetId: target.id,
        code: context.blocked.code,
        retryAt: retryAt.toISOString(),
      });
      return { outcome: 'retryable_failed', reason: context.blocked.code };
    }

    await markTargetPermanentFailure(db, {
      targetId: target.id,
      leaseId,
      errorCode: context.blocked.code,
      errorMessage: context.blocked.message,
    });
    await recalculatePostStatus(db, target.postId);
    return { outcome: 'permanent_failed', reason: context.blocked.code };
  }

  // ---- 2b. simulation ------------------------------------------------------
  /**
   * Plan §49. Everything up to here has run: the lease, ownership, connection health,
   * content and override resolution, media resolution and signing. What does not run is
   * the provider call itself.
   *
   * The target still ends `published`, and the post still ends `published`, and the
   * customer webhook still fires. That is deliberate. A test mode whose state machine
   * differs from production forces every customer to write a branch in order to test
   * themselves, which defeats the point of having one. What marks it as a rehearsal is the
   * synthetic external id and the `simulated` flag on the attempt — not a different shape.
   *
   * No rate-limit permit is taken. Nothing is going to reach the provider, so consuming
   * from a budget shared with real publishes would let a simulation throttle production.
   */
  if (context.simulate) {
    const { attemptId: simulatedAttemptId } = await startPublishAttempt(db, {
      postTargetId: target.id,
      postId: target.postId,
      attemptNumber,
      leaseId,
      traceId: message.traceId ?? null,
    });

    const externalPostId = `sim_${toPublicId('postTarget', target.id)}`;

    await markTargetPublished(db, {
      targetId: target.id,
      leaseId,
      providerPostId: externalPostId,
      // No URL, ever. A link that 404s is worse than no link, and it is the one field a
      // reader would use to check whether a simulated post is real.
      providerPostUrl: null,
      now: new Date(),
      simulated: true,
    });

    await finishPublishAttempt(db, {
      attemptId: simulatedAttemptId,
      outcome: 'published',
      providerPostId: externalPostId,
      durationMs: Date.now() - startedAt,
      simulated: true,
    });

    await recalculatePostStatus(db, target.postId);

    logger.info('target.simulated', { postTargetId: target.id, provider: target.provider });
    return { outcome: 'published', reason: 'simulated' };
  }

  // ---- 3. rate-limit permit ------------------------------------------------
  const limiter = new RateLimiterClient(env.RATE_LIMITER);
  const limitKey = `${target.provider}:destination:${target.destinationId}`;
  const permit = await limiter.acquire(limitKey);

  if (!permit.granted) {
    // Release rather than fail. Nothing was attempted, so this must not consume an
    // attempt from the budget or look like a failure in the timeline.
    const retryAt = new Date(Date.now() + (permit.retryAfterMs ?? 5_000));
    await releaseTargetLease(db, { targetId: target.id, leaseId, retryAt });

    if (env.PUBLISH_QUEUE) {
      await env.PUBLISH_QUEUE.send(
        { type: 'publish.target', postId: target.postId, postTargetId: target.id, traceId: message.traceId },
        { delaySeconds: Math.max(1, Math.ceil((permit.retryAfterMs ?? 5_000) / 1000)) },
      );
    }

    logger.info('target.rate_limited', { postTargetId: target.id, reason: permit.reason });
    return { outcome: 'skipped', reason: `rate_limited:${permit.reason}` };
  }

  // ---- 4. attempt record ---------------------------------------------------
  // Opened before the provider call, so a worker that dies mid-call still leaves evidence
  // that something was attempted (Rule 6). An attempt written only on success would make
  // the most important failures invisible.
  const { attemptId } = await startPublishAttempt(db, {
    postTargetId: target.id,
    postId: target.postId,
    attemptNumber,
    leaseId,
    traceId: message.traceId ?? null,
  });

  const callContext = providerContext(env, {
    requestId: `pub_${target.id}`,
    traceId: message.traceId ?? 'trc_publisher',
    timeoutMs: PROVIDER_TIMEOUT_MS,
    logger,
  });

  try {
    // ---- 5. prepare --------------------------------------------------------
    const prepared = await adapter.publishing.prepare({
      context: callContext,
      app: context.app,
      credentials: context.credentials,
      target: {
        postId: toPublicId('post', target.postId),
        postTargetId: toPublicId('postTarget', target.id),
        destinationExternalId: context.destinationExternalId,
      },
      content: context.content,
    });

    // ---- 5b. persist what preparation created -------------------------------
    // Before the irreversible call, never after. If the publish below never returns, these
    // ids are the only thing that lets reconciliation ask the provider a direct question
    // instead of guessing from recent post text (ADR-006 Layer 4).
    await recordPreparedProviderIds(db, {
      targetId: target.id,
      leaseId,
      providerIds: prepared.providerMediaIds,
    });

    // ---- 6. publish --------------------------------------------------------
    const result = await adapter.publishing.publish({
      context: callContext,
      app: context.app,
      credentials: context.credentials,
      target: {
        postId: toPublicId('post', target.postId),
        postTargetId: toPublicId('postTarget', target.id),
        destinationExternalId: context.destinationExternalId,
      },
      content: context.content,
      prepared,
      // ADR-006 Layer 3 — handed to providers that support an idempotency key, which is
      // the cheapest duplicate defence available and must be used where offered.
      idempotencyKey: target.contentFingerprint ?? target.id,
    });

    await limiter.report({ key: limitKey, permitId: permit.permitId, status: 200 });

    // ---- 7. classify -------------------------------------------------------
    if (result.outcome === 'processing') {
      await markTargetProviderProcessing(db, {
        targetId: target.id,
        leaseId,
        providerPostId: result.externalPostId,
        // The provider decides when it is done; 15s is a first poll, not a deadline.
        checkAt: new Date(Date.now() + 15_000),
      });

      await finishPublishAttempt(db, {
        attemptId,
        outcome: 'provider_processing',
        providerPostId: result.externalPostId,
        durationMs: Date.now() - startedAt,
      });

      if (env.PUBLISH_QUEUE) {
        await env.PUBLISH_QUEUE.send(
          { type: 'publish.poll_status', postId: target.postId, postTargetId: target.id, traceId: message.traceId },
          { delaySeconds: 15 },
        );
      }

      await recalculatePostStatus(db, target.postId);
      return { outcome: 'processing' };
    }

    await markTargetPublished(db, {
      targetId: target.id,
      leaseId,
      providerPostId: result.externalPostId,
      providerPostUrl: result.externalUrl,
      // The provider's own timestamp when it gives one — ours is when we heard back,
      // which can be seconds later and is what a customer would notice as wrong.
      now: result.publishedAt ? new Date(result.publishedAt) : new Date(),
    });

    await finishPublishAttempt(db, {
      attemptId,
      outcome: 'published',
      providerPostId: result.externalPostId,
      durationMs: Date.now() - startedAt,
    });

    await recalculatePostStatus(db, target.postId);

    logger.info('target.published', {
      postTargetId: target.id,
      provider: target.provider,
      durationMs: Date.now() - startedAt,
    });

    return { outcome: 'published' };
  } catch (error) {
    const normalized = adapter.normalizeError(error, {
      operation: 'publish',
      provider: target.provider,
    });

    await limiter.report({
      key: limitKey,
      permitId: permit.permitId,
      status: normalized.status,
      retryAfterMs: normalized.retryAfter ? Date.parse(normalized.retryAfter) : undefined,
    });

    return fail(normalized, attemptId, startedAt);
  } finally {
    await limiter.release(limitKey, permit.permitId ?? '');
  }
}
