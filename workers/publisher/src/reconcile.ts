import { toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import { getPostWithTargets, recalculatePostStatus, resolveReconciliation, type Database } from '@gs/db';
import { getAdapter, hasAdapter } from '@gs/providers';
import type { Logger } from '@gs/observability';

import type { Env, ReconcileMessage } from './env.js';
import { loadPublishContext } from './load-context.js';
import { providerContext } from './provider-context.js';

/**
 * Reconciliation (ADR-006 Layer 4, plan §25).
 *
 * Runs when a target is in `unknown_reconciliation_required` — an ambiguous failure where
 * the post may or may not have been created. Plan §2.2 names this as the failure mode
 * competitors are known for: the request times out, the post actually published, the
 * engine retries, and the customer gets two posts.
 *
 * Three possible conclusions, and the middle one is the reason this exists:
 *
 *   found          adopt the existing post. Do NOT publish again.
 *   absent         provably nothing was created. Safe to retry.
 *   indeterminate  cannot tell. Do NOT retry — escalate to a human instead.
 *
 * `indeterminate` failing closed is the whole point. Retrying on uncertainty is how you
 * get a duplicate, and a duplicate cannot be undone.
 */

const RECONCILE_TIMEOUT_MS = 30_000;

/** How far back to search. Wide enough for a slow provider, narrow enough not to adopt an unrelated post. */
const LOOKBACK_MS = 30 * 60 * 1000;

export async function reconcileTarget(
  db: Database,
  env: Env,
  message: ReconcileMessage,
  logger: Logger,
): Promise<'found' | 'absent' | 'indeterminate' | 'skipped'> {
  const found = await getPostWithTargets(db, message.postId);
  const target = found?.targets.find((t) => t.id === message.postTargetId);

  if (!target) return 'skipped';
  if (target.status !== 'unknown_reconciliation_required') {
    // Something else already resolved it. Reconciling again could adopt a post that a
    // legitimate later attempt created.
    return 'skipped';
  }

  if (!isProviderName(target.provider) || !hasAdapter(target.provider)) return 'skipped';
  const adapter = getAdapter(target.provider);

  if (!adapter.publishing.findPossibleDuplicate) {
    // The adapter cannot search. Nothing can be concluded, so the target stays where it
    // is for a human — which is correct, and is why the certification harness demands a
    // written justification before an adapter may omit this.
    logger.warn('reconcile.unsupported', {
      postTargetId: target.id,
      provider: target.provider,
    });
    return 'indeterminate';
  }

  const context = await loadPublishContext(db, env, target);
  if (context.blocked) {
    // Cannot even authenticate to look. Leave it for a human rather than guessing.
    logger.warn('reconcile.blocked', { postTargetId: target.id, reason: context.blocked.code });
    return 'indeterminate';
  }

  const result = await adapter.publishing.findPossibleDuplicate({
    context: providerContext(env, {
      requestId: `rec_${target.id}`,
      traceId: message.traceId ?? 'trc_reconciler',
      timeoutMs: RECONCILE_TIMEOUT_MS,
      logger,
    }),
    app: context.app,
    credentials: context.credentials,
    target: {
      postId: toPublicId('post', target.postId),
      postTargetId: toPublicId('postTarget', target.id),
      destinationExternalId: context.destinationExternalId,
    },
    content: context.content,
    idempotencyKey: target.contentFingerprint ?? target.id,
    attemptedAfter: new Date(Date.now() - LOOKBACK_MS).toISOString(),
    // Recorded by the attempt that failed, before it made the irreversible call. For a
    // container-based platform this lets the adapter ask "was container X published?"
    // instead of searching recent posts for matching text.
    providerMediaIds: target.preparedProviderIds ?? [],
  });

  if (result.conclusion === 'found' && result.externalPostId) {
    // The post exists. Adopt it — the customer's post is live, and the only thing wrong
    // was our record of it.
    // Guarded by status, not by a lease: the publishing lease was released when the
    // target entered reconciliation, so only the status transition can serialize this.
    await resolveReconciliation(db, {
      targetId: target.id,
      outcome: 'published',
      providerPostId: result.externalPostId,
      providerPostUrl: result.externalUrl ?? null,
      publishedAt: result.publishedAt ? new Date(result.publishedAt) : new Date(),
    });

    await recalculatePostStatus(db, target.postId);
    logger.info('reconcile.adopted_existing_post', {
      postTargetId: target.id,
      externalPostId: result.externalPostId,
    });
    return 'found';
  }

  if (result.conclusion === 'absent') {
    // Provably nothing was created, so a retry cannot duplicate anything.
    await resolveReconciliation(db, {
      targetId: target.id,
      outcome: 'retryable_failed',
      errorCode: 'RECONCILIATION_REQUIRED',
      errorMessage: 'Reconciliation confirmed nothing was published. Retrying.',
      nextAttemptAt: new Date(),
    });

    if (env.PUBLISH_QUEUE) {
      await env.PUBLISH_QUEUE.send({
        type: 'publish.target',
        postId: target.postId,
        postTargetId: target.id,
        traceId: message.traceId,
      });
    }

    await recalculatePostStatus(db, target.postId);
    logger.info('reconcile.confirmed_absent', { postTargetId: target.id });
    return 'absent';
  }

  // Indeterminate. Fail permanently rather than retry: a human can republish deliberately,
  // but nobody can un-publish a duplicate (Rule 14).
  await resolveReconciliation(db, {
    targetId: target.id,
    outcome: 'permanent_failed',
    errorCode: 'RECONCILIATION_REQUIRED',
    errorMessage:
      result.reason ??
      'Could not determine whether this post was published. Check the destination before retrying.',
  });

  await recalculatePostStatus(db, target.postId);
  logger.error('reconcile.indeterminate', { postTargetId: target.id, reason: result.reason });
  return 'indeterminate';
}
