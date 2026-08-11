import { toPublicId } from '@gs/contracts/ids';
import { isProviderName, type ProviderName } from '@gs/contracts/providers';
import type { Post, PostTarget, PostTargetAttempt } from '@gs/db';

/**
 * The post timeline (plan §40).
 *
 * Assembled from what already happened rather than from an event log written alongside it.
 * Three tables carry the full story — the post, its targets, and every attempt — and
 * deriving the timeline from them means it cannot disagree with the state it describes.
 * A separate append-only timeline table would be a second source of truth that drifts the
 * first time a worker crashes between writing the row and writing the event.
 *
 * Ordered strictly by time, never grouped by target. What an integrator opens a timeline
 * to see is that one provider stalled for twenty seconds while another published in two,
 * and grouping by target hides exactly that.
 */

export interface TimelineEvent {
  at: string;
  type: string;
  message: string;
  target_id: string | null;
  provider: ProviderName | null;
  error_code: string | null;
  attempt: number | null;
  duration_ms: number | null;
}

function providerOrNull(value: string): ProviderName | null {
  return isProviderName(value) ? value : null;
}

/** Provider name for display, without pulling the display-name map into the API layer. */
function label(provider: string): string {
  return provider.replaceAll('_', ' ');
}

export function buildPostTimeline(
  post: Post,
  targets: readonly PostTarget[],
  attempts: readonly PostTargetAttempt[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const targetById = new Map(targets.map((target) => [target.id, target]));

  const push = (event: TimelineEvent): void => {
    events.push(event);
  };

  push({
    at: post.createdAt.toISOString(),
    type: 'post.accepted',
    message:
      post.publishAt && post.publishAt > post.createdAt
        ? `Post accepted, scheduled for ${post.publishAt.toISOString()}.`
        : `Post accepted with ${targets.length} target${targets.length === 1 ? '' : 's'}.`,
    target_id: null,
    provider: null,
    error_code: null,
    attempt: null,
    duration_ms: null,
  });

  // Target creation is the moment each destination was committed to. It is stamped from
  // the target's own `createdAt` rather than the post's, because a retry can add one
  // later and dating it to the post would put it in the wrong place in the story.
  for (const target of targets) {
    push({
      at: target.createdAt.toISOString(),
      type: 'target.queued',
      message: `${label(target.provider)} target queued.`,
      target_id: toPublicId('postTarget', target.id),
      provider: providerOrNull(target.provider),
      error_code: null,
      attempt: null,
      duration_ms: null,
    });
  }

  for (const attempt of attempts) {
    const target = targetById.get(attempt.postTargetId);
    const provider = target ? target.provider : 'unknown';
    const targetId = toPublicId('postTarget', attempt.postTargetId);

    push({
      at: attempt.startedAt.toISOString(),
      type: 'target.publishing',
      message: `${label(provider)} attempt ${attempt.attemptNumber} started.`,
      target_id: targetId,
      provider: target ? providerOrNull(target.provider) : null,
      error_code: null,
      attempt: attempt.attemptNumber,
      duration_ms: null,
    });

    if (!attempt.finishedAt) continue;

    // An in-flight attempt has no outcome yet, and inventing one would misreport a worker
    // that is still running as a failure.
    const outcome = attempt.outcome;
    const finished: TimelineEvent = {
      at: attempt.finishedAt.toISOString(),
      type: 'target.attempt_finished',
      message: '',
      target_id: targetId,
      provider: target ? providerOrNull(target.provider) : null,
      error_code: attempt.errorCode,
      attempt: attempt.attemptNumber,
      duration_ms: attempt.durationMs,
    };

    const reason = attempt.errorMessage ?? attempt.errorCode ?? 'no reason recorded';

    switch (outcome) {
      case 'published':
        finished.type = 'target.published';
        finished.message = attempt.providerPostId
          ? `${label(provider)} published as ${attempt.providerPostId}.`
          : `${label(provider)} published.`;
        break;
      case 'retryable_failed':
        finished.type = 'target.failed';
        finished.message = `${label(provider)} failed and will be retried: ${reason}`;
        break;
      case 'permanent_failed':
        finished.type = 'target.failed';
        finished.message = `${label(provider)} failed permanently: ${reason}`;
        break;
      case 'provider_processing':
        finished.type = 'target.provider_processing';
        finished.message = `${label(provider)} accepted the post and is still processing it.`;
        break;
      case 'unknown_reconciliation_required':
        finished.type = 'target.reconciliation_required';
        // The single most consequential entry in the whole timeline: it says we do not
        // know whether the post went out, which is why nothing was retried automatically.
        finished.message =
          `${label(provider)} did not answer conclusively. The outcome is unknown and is ` +
          `being reconciled before anything is retried.`;
        break;
      case 'skipped':
        finished.type = 'target.skipped';
        finished.message = `${label(provider)} was skipped: ${reason}`;
        break;
      default:
        finished.message = `${label(provider)} attempt ${attempt.attemptNumber} finished.`;
    }

    push(finished);
  }

  // The aggregate transition last, dated from the post itself. It is genuinely the final
  // fact: the post's status is recalculated only after every target has settled (§78).
  if (post.status !== 'queued' && post.status !== 'scheduled' && post.status !== 'draft') {
    push({
      at: post.updatedAt.toISOString(),
      type: `post.${post.status}`,
      message: `Post is ${post.status.replaceAll('_', ' ')}.`,
      target_id: null,
      provider: null,
      error_code: null,
      attempt: null,
      duration_ms: null,
    });
  }

  return events.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
}
