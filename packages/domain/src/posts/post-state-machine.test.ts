import { describe, expect, it } from 'vitest';

import {
  ACTIVE_TARGET_STATUSES,
  InvalidTargetTransitionError,
  POST_TARGET_STATUSES,
  assertTargetTransition,
  canCancelPost,
  canTransitionTarget,
  isTerminalTargetStatus,
  reducePostStatus,
  selectTargetsForRetry,
} from './post-state-machine.js';
import type { PostTargetStatus } from './post-state-machine.js';

describe('reducePostStatus', () => {
  it('reports published only when every target published', () => {
    expect(reducePostStatus(['published', 'published', 'published'])).toBe('published');
  });

  it('reports partially_published on a mixed terminal outcome', () => {
    // Plan §26: Instagram ✓, LinkedIn ✓, Facebook ✗ is the defining case for this product.
    expect(reducePostStatus(['published', 'published', 'permanent_failed'])).toBe('partially_published');
  });

  it('reports failed when everything terminal failed', () => {
    expect(reducePostStatus(['permanent_failed', 'permanent_failed'])).toBe('failed');
    expect(reducePostStatus(['permanent_failed', 'blocked_validation'])).toBe('failed');
  });

  it('reports publishing while any target is still in flight', () => {
    // Even alongside a success and a failure — the post is not finished.
    expect(reducePostStatus(['published', 'permanent_failed', 'publishing'])).toBe('publishing');
    expect(reducePostStatus(['queued'])).toBe('publishing');
    expect(reducePostStatus(['provider_processing'])).toBe('publishing');
  });

  it('treats a retryable failure as still in flight, not as a final failure', () => {
    // A retryable target will be picked up again, so reporting `failed` here would
    // announce a defeat that has not happened.
    expect(reducePostStatus(['retryable_failed'])).toBe('publishing');
    expect(reducePostStatus(['published', 'retryable_failed'])).toBe('publishing');
  });

  it('treats an unknown outcome as in flight until reconciliation resolves it', () => {
    expect(reducePostStatus(['unknown_reconciliation_required'])).toBe('publishing');
    expect(reducePostStatus(['published', 'unknown_reconciliation_required'])).toBe('publishing');
  });

  it('reports scheduled only when nothing is in flight', () => {
    expect(reducePostStatus(['scheduled', 'scheduled'])).toBe('scheduled');
    expect(reducePostStatus(['scheduled', 'publishing'])).toBe('publishing');
  });

  it('surfaces an approval wait above a schedule', () => {
    expect(reducePostStatus(['awaiting_approval', 'scheduled'])).toBe('awaiting_approval');
  });

  it('reports cancelled only when every target was cancelled', () => {
    expect(reducePostStatus(['cancelled', 'cancelled'])).toBe('cancelled');
  });

  it('ignores cancelled targets when judging the rest', () => {
    // Cancelling one of three destinations must not turn two real successes into a
    // partial or a failure.
    expect(reducePostStatus(['published', 'published', 'cancelled'])).toBe('published');
    expect(reducePostStatus(['permanent_failed', 'cancelled'])).toBe('failed');
    expect(reducePostStatus(['published', 'permanent_failed', 'cancelled'])).toBe('partially_published');
  });

  it('reports failed for a post with no targets', () => {
    expect(reducePostStatus([])).toBe('failed');
  });

  it('reports queued while targets exist but nothing has been dispatched', () => {
    expect(reducePostStatus(['pending', 'pending'])).toBe('queued');
  });

  it('never returns a non-terminal status once every target is terminal', () => {
    const terminal: PostTargetStatus[] = ['published', 'permanent_failed', 'cancelled', 'blocked_validation'];

    for (const a of terminal) {
      for (const b of terminal) {
        const status = reducePostStatus([a, b]);
        expect(['published', 'partially_published', 'failed', 'cancelled'], `${a}+${b} → ${status}`).toContain(
          status,
        );
      }
    }
  });

  it('is order independent', () => {
    expect(reducePostStatus(['published', 'permanent_failed'])).toBe(
      reducePostStatus(['permanent_failed', 'published']),
    );
    expect(reducePostStatus(['publishing', 'published', 'cancelled'])).toBe(
      reducePostStatus(['cancelled', 'published', 'publishing']),
    );
  });

  it('produces a defined status for every single-target case', () => {
    for (const status of POST_TARGET_STATUSES) {
      expect(reducePostStatus([status]), status).toBeTruthy();
    }
  });
});

describe('target transitions', () => {
  it('never allows a published target to move', () => {
    // The strongest invariant in the system: nothing may un-publish or republish.
    for (const status of POST_TARGET_STATUSES) {
      if (status === 'published') continue;
      expect(canTransitionTarget('published', status), `published → ${status}`).toBe(false);
    }
  });

  it('never allows a terminal failure or cancellation to move', () => {
    for (const from of ['permanent_failed', 'cancelled'] as const) {
      for (const to of POST_TARGET_STATUSES) {
        if (to === from) continue;
        expect(canTransitionTarget(from, to), `${from} → ${to}`).toBe(false);
      }
    }
  });

  it('allows the normal publish path', () => {
    expect(canTransitionTarget('pending', 'queued')).toBe(true);
    expect(canTransitionTarget('queued', 'publishing')).toBe(true);
    expect(canTransitionTarget('publishing', 'published')).toBe(true);
    expect(canTransitionTarget('publishing', 'provider_processing')).toBe(true);
    expect(canTransitionTarget('provider_processing', 'published')).toBe(true);
  });

  it('allows a retry to re-enter the queue but not to skip straight to published', () => {
    expect(canTransitionTarget('retryable_failed', 'queued')).toBe(true);
    expect(canTransitionTarget('retryable_failed', 'published')).toBe(false);
  });

  it('lets reconciliation resolve an unknown outcome either way', () => {
    expect(canTransitionTarget('unknown_reconciliation_required', 'published')).toBe(true);
    expect(canTransitionTarget('unknown_reconciliation_required', 'permanent_failed')).toBe(true);
    expect(canTransitionTarget('unknown_reconciliation_required', 'queued')).toBe(true);
  });

  it('treats a same-status transition as a no-op, so redelivery is safe', () => {
    for (const status of POST_TARGET_STATUSES) {
      expect(canTransitionTarget(status, status), status).toBe(true);
    }
  });

  it('throws with both states named', () => {
    expect(() => assertTargetTransition('published', 'queued')).toThrow(InvalidTargetTransitionError);
    expect(() => assertTargetTransition('published', 'queued')).toThrow(/published → queued/);
  });
});

describe('terminality', () => {
  it('does not treat a retryable failure as terminal', () => {
    expect(isTerminalTargetStatus('retryable_failed')).toBe(false);
    expect(isTerminalTargetStatus('unknown_reconciliation_required')).toBe(false);
  });

  it('treats published, permanently failed, cancelled and blocked as terminal', () => {
    expect(isTerminalTargetStatus('published')).toBe(true);
    expect(isTerminalTargetStatus('permanent_failed')).toBe(true);
    expect(isTerminalTargetStatus('cancelled')).toBe(true);
    expect(isTerminalTargetStatus('blocked_validation')).toBe(true);
  });

  it('keeps active and terminal sets disjoint', () => {
    for (const status of ACTIVE_TARGET_STATUSES) {
      expect(isTerminalTargetStatus(status), status).toBe(false);
    }
  });
});

describe('cancellation', () => {
  it('permits cancellation before publishing begins', () => {
    for (const status of ['draft', 'validating', 'awaiting_approval', 'scheduled', 'queued'] as const) {
      expect(canCancelPost(status), status).toBe(true);
    }
  });

  it('refuses cancellation once publishing has begun or finished', () => {
    for (const status of ['publishing', 'published', 'partially_published', 'failed', 'cancelled'] as const) {
      expect(canCancelPost(status), status).toBe(false);
    }
  });
});

describe('retry selection', () => {
  const targets = [
    { id: 'a', status: 'published' as const },
    { id: 'b', status: 'retryable_failed' as const },
    { id: 'c', status: 'permanent_failed' as const },
    { id: 'd', status: 'publishing' as const },
  ];

  it('never resubmits a successful target', () => {
    // Plan §26. Republishing a success is the worst possible retry behaviour.
    const selected = selectTargetsForRetry(targets);

    expect(selected.map((target) => target.id)).toEqual(['b', 'c']);
    expect(selected.some((target) => target.status === 'published')).toBe(false);
  });

  it('never picks up a target that is still in flight', () => {
    expect(selectTargetsForRetry(targets).some((target) => target.status === 'publishing')).toBe(false);
  });

  it('can narrow to genuinely retryable targets only', () => {
    expect(selectTargetsForRetry(targets, 'retryable_only').map((target) => target.id)).toEqual(['b']);
  });
});
