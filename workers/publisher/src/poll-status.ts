import { toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import {
  getPostWithTargets,
  markTargetPermanentFailure,
  markTargetPublished,
  recalculatePostStatus,
  type Database,
} from '@gs/db';
import { getAdapter, hasAdapter } from '@gs/providers';
import type { Logger } from '@gs/observability';

import type { Env, PollStatusMessage } from './env.js';
import { loadPublishContext } from './load-context.js';
import { providerContext } from './provider-context.js';

/**
 * Poll a provider that accepted a post but is still processing it (plan §12.2).
 *
 * Several platforms transcode video asynchronously: the publish call returns immediately
 * with an id, and the post is not actually live for anything from seconds to minutes.
 * Reporting `published` at that point would be a lie the customer can see — they click
 * the link and find nothing.
 */

const POLL_TIMEOUT_MS = 20_000;

/** Give up polling after this. A provider still processing after 30 minutes has a problem. */
const MAX_POLL_AGE_MS = 30 * 60 * 1000;

/** Backoff between polls. Linear, not exponential — transcoding finishes on its own schedule. */
const POLL_INTERVAL_SECONDS = 30;

export async function pollTargetStatus(
  db: Database,
  env: Env,
  message: PollStatusMessage,
  logger: Logger,
): Promise<'published' | 'processing' | 'failed' | 'skipped'> {
  const found = await getPostWithTargets(db, message.postId);
  const target = found?.targets.find((t) => t.id === message.postTargetId);

  if (!target || target.status !== 'provider_processing') return 'skipped';
  if (!isProviderName(target.provider) || !hasAdapter(target.provider)) return 'skipped';

  const adapter = getAdapter(target.provider);
  if (!adapter.publishing.status || !target.providerPostId) return 'skipped';

  const age = Date.now() - target.updatedAt.getTime();
  if (age > MAX_POLL_AGE_MS) {
    // Stop polling, but do not claim it failed to publish — the provider has an id for
    // it, and a human should look rather than the engine guessing.
    await markTargetPermanentFailure(db, {
      targetId: target.id,
      leaseId: target.leaseId ?? '',
      errorCode: 'PROVIDER_TIMEOUT',
      errorMessage: 'The provider is still processing this post after 30 minutes.',
    });
    await recalculatePostStatus(db, target.postId);
    logger.warn('poll.gave_up', { postTargetId: target.id, ageMs: age });
    return 'failed';
  }

  const context = await loadPublishContext(db, env, target);
  if (context.blocked) return 'skipped';

  const result = await adapter.publishing.status({
    context: providerContext(env, {
      requestId: `poll_${target.id}`,
      traceId: message.traceId ?? 'trc_poller',
      timeoutMs: POLL_TIMEOUT_MS,
      logger,
    }),
    app: context.app,
    credentials: context.credentials,
    target: {
      postId: toPublicId('post', target.postId),
      postTargetId: toPublicId('postTarget', target.id),
      destinationExternalId: context.destinationExternalId,
    },
    statusHandle: target.providerPostId,
  });

  if (result.outcome === 'published' && result.externalPostId) {
    await markTargetPublished(db, {
      targetId: target.id,
      leaseId: target.leaseId ?? '',
      providerPostId: result.externalPostId,
      providerPostUrl: result.externalUrl ?? null,
      now: result.publishedAt ? new Date(result.publishedAt) : new Date(),
    });
    await recalculatePostStatus(db, target.postId);
    logger.info('poll.published', { postTargetId: target.id });
    return 'published';
  }

  if (result.outcome === 'failed') {
    // The provider accepted it and then failed to process it. Permanent: the same bytes
    // will fail the same way, and a retry would only add a second failed upload.
    await markTargetPermanentFailure(db, {
      targetId: target.id,
      leaseId: target.leaseId ?? '',
      errorCode: 'MEDIA_PROCESSING_FAILED',
      errorMessage: result.failureReason ?? 'The provider failed to process this post.',
    });
    await recalculatePostStatus(db, target.postId);
    return 'failed';
  }

  if (env.PUBLISH_QUEUE) {
    await env.PUBLISH_QUEUE.send(
      { type: 'publish.poll_status', postId: target.postId, postTargetId: target.id, traceId: message.traceId },
      { delaySeconds: POLL_INTERVAL_SECONDS },
    );
  }

  return 'processing';
}
