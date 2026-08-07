/**
 * Post and target state machines (plan §12.1, §12.2) and the aggregate reducer (§78).
 *
 * Pure functions with no I/O. Infrastructure (`@gs/db`) depends on this, never the
 * reverse — dependencies point inward toward the domain.
 */

export const POST_STATUSES = [
  'draft',
  'validating',
  'awaiting_approval',
  'scheduled',
  'queued',
  'publishing',
  'published',
  'partially_published',
  'failed',
  'cancelled',
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

export const POST_TARGET_STATUSES = [
  'pending',
  'blocked_validation',
  'awaiting_approval',
  'scheduled',
  'queued',
  'preparing_media',
  'publishing',
  'provider_processing',
  'published',
  'retryable_failed',
  'permanent_failed',
  'cancelled',
  'unknown_reconciliation_required',
] as const;

export type PostTargetStatus = (typeof POST_TARGET_STATUSES)[number];

/**
 * Statuses from which no further work happens without an explicit customer action.
 *
 * `retryable_failed` is deliberately NOT terminal — the publisher will pick it up again.
 * `unknown_reconciliation_required` is not terminal either; reconciliation moves it.
 */
export const TERMINAL_TARGET_STATUSES: ReadonlySet<PostTargetStatus> = new Set([
  'published',
  'permanent_failed',
  'cancelled',
  'blocked_validation',
]);

/** Statuses a queue consumer is allowed to lease and execute (ADR-006 Layer 2). */
export const LEASABLE_TARGET_STATUSES: readonly PostTargetStatus[] = [
  'queued',
  'retryable_failed',
  'scheduled',
];

/** Statuses where work is actively in flight at, or on its way to, the provider. */
export const ACTIVE_TARGET_STATUSES: ReadonlySet<PostTargetStatus> = new Set([
  'queued',
  'preparing_media',
  'publishing',
  'provider_processing',
  'retryable_failed',
  'unknown_reconciliation_required',
]);

export function isTerminalTargetStatus(status: PostTargetStatus): boolean {
  return TERMINAL_TARGET_STATUSES.has(status);
}

export function isTerminalPostStatus(status: PostStatus): boolean {
  return status === 'published' || status === 'partially_published' || status === 'failed' || status === 'cancelled';
}

/**
 * Legal target transitions.
 *
 * Enforced so an out-of-order queue delivery cannot walk a published target back to
 * `queued` and republish it. This is the in-process complement to the database lease.
 */
const TARGET_TRANSITIONS: Record<PostTargetStatus, readonly PostTargetStatus[]> = {
  pending: ['blocked_validation', 'awaiting_approval', 'scheduled', 'queued', 'cancelled'],
  blocked_validation: ['pending', 'queued', 'cancelled'],
  awaiting_approval: ['scheduled', 'queued', 'cancelled', 'blocked_validation'],
  scheduled: ['queued', 'publishing', 'cancelled', 'blocked_validation'],
  queued: ['preparing_media', 'publishing', 'cancelled', 'retryable_failed', 'permanent_failed', 'blocked_validation'],
  preparing_media: ['publishing', 'retryable_failed', 'permanent_failed', 'cancelled'],
  publishing: [
    'published',
    'provider_processing',
    'retryable_failed',
    'permanent_failed',
    'unknown_reconciliation_required',
  ],
  provider_processing: [
    'published',
    'retryable_failed',
    'permanent_failed',
    'unknown_reconciliation_required',
  ],
  // A published target is final. Nothing may move it — that is the whole point.
  published: [],
  retryable_failed: ['queued', 'publishing', 'permanent_failed', 'cancelled'],
  permanent_failed: [],
  cancelled: [],
  unknown_reconciliation_required: [
    'published',
    'permanent_failed',
    'retryable_failed',
    'queued',
  ],
};

export function canTransitionTarget(from: PostTargetStatus, to: PostTargetStatus): boolean {
  if (from === to) return true;
  return TARGET_TRANSITIONS[from].includes(to);
}

export class InvalidTargetTransitionError extends Error {
  constructor(
    readonly from: PostTargetStatus,
    readonly to: PostTargetStatus,
  ) {
    super(`Illegal publish-target transition ${from} → ${to}.`);
    this.name = 'InvalidTargetTransitionError';
  }
}

export function assertTargetTransition(from: PostTargetStatus, to: PostTargetStatus): void {
  if (!canTransitionTarget(from, to)) {
    throw new InvalidTargetTransitionError(from, to);
  }
}

/**
 * The post aggregate reducer (plan §78).
 *
 * A post's status is DERIVED from its targets and is never set from timestamps
 * (plan §12.1). Keeping this as one pure, exhaustively tested function is what makes
 * "partially published" a reliable signal rather than an accident of ordering.
 *
 * Precedence, evaluated in order:
 *
 *   1. no targets              → failed (nothing can ever publish)
 *   2. all cancelled           → cancelled
 *   3. any actively working    → publishing
 *   4. any awaiting approval   → awaiting_approval
 *   5. any scheduled           → scheduled
 *   6. all published           → published
 *   7. some published, rest terminal-failed → partially_published
 *   8. all terminal, none published         → failed
 *   9. otherwise               → queued
 */
export function reducePostStatus(targetStatuses: readonly PostTargetStatus[]): PostStatus {
  if (targetStatuses.length === 0) return 'failed';

  const count = (predicate: (status: PostTargetStatus) => boolean): number =>
    targetStatuses.filter(predicate).length;

  const total = targetStatuses.length;
  const cancelled = count((status) => status === 'cancelled');
  if (cancelled === total) return 'cancelled';

  // Cancelled targets are excluded from the outcome calculation: a customer who cancels
  // one destination of three should still see the other two's real result.
  const live = targetStatuses.filter((status) => status !== 'cancelled');

  const published = live.filter((status) => status === 'published').length;
  const active = live.filter((status) => ACTIVE_TARGET_STATUSES.has(status)).length;
  const awaitingApproval = live.filter((status) => status === 'awaiting_approval').length;
  const scheduled = live.filter((status) => status === 'scheduled').length;
  const terminalFailed = live.filter(
    (status) => status === 'permanent_failed' || status === 'blocked_validation',
  ).length;

  // Anything in flight dominates: the post is not finished, whatever else is true.
  if (active > 0) return 'publishing';
  if (awaitingApproval > 0) return 'awaiting_approval';
  if (scheduled > 0) return 'scheduled';

  if (published === live.length) return 'published';
  if (published > 0 && published + terminalFailed === live.length) return 'partially_published';
  if (terminalFailed === live.length) return 'failed';

  // Everything left is `pending` — created but not yet dispatched.
  return 'queued';
}

/**
 * Whether a post may still be cancelled.
 *
 * Cancellation is best-effort by nature: targets already published cannot be un-published
 * by cancelling, so a post that has begun succeeding is not cancellable as a whole.
 */
export function canCancelPost(status: PostStatus): boolean {
  return (
    status === 'draft' ||
    status === 'validating' ||
    status === 'awaiting_approval' ||
    status === 'scheduled' ||
    status === 'queued'
  );
}

/** Targets a `scope: "failed_targets"` retry should touch (plan §26). */
export function isRetryableTargetStatus(status: PostTargetStatus): boolean {
  return status === 'retryable_failed' || status === 'permanent_failed';
}

/**
 * Which targets a retry request selects.
 *
 * Default is `failed_targets`, and a successful target is NEVER resubmitted — republishing
 * something that already worked is the single worst thing a retry endpoint can do
 * (plan §26).
 */
export function selectTargetsForRetry<T extends { status: PostTargetStatus }>(
  targets: readonly T[],
  scope: 'failed_targets' | 'retryable_only' = 'failed_targets',
): T[] {
  if (scope === 'retryable_only') {
    return targets.filter((target) => target.status === 'retryable_failed');
  }
  return targets.filter((target) => isRetryableTargetStatus(target.status));
}
