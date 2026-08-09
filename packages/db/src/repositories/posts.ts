import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { newUuidV7 } from '@gs/contracts/ids';
import type { PostStatus, PostTargetStatus } from '@gs/domain';
import { reducePostStatus } from '@gs/domain';

import type { Database, Transaction } from '../client.js';
import { posts, postTargetAttempts, postTargets } from '../schema/posts.js';
import type { Post, PostTarget } from '../schema/posts.js';

/**
 * Domain-shaped publishing repository (plan §76).
 *
 * These are not CRUD wrappers. Each function expresses one operation whose concurrency
 * behaviour matters, so that behaviour is written once and tested once.
 */

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateTargetInput {
  destinationId: string;
  connectionId: string;
  provider: string;
  overrides?: Record<string, unknown> | null;
  options?: Record<string, unknown> | null;
  contentFingerprint?: string | null;
  status?: PostTargetStatus;
  maxAttempts?: number;
}

export interface CreatePostWithTargetsInput {
  postId?: string;
  profileId: string;
  projectEnvironmentId: string;
  projectId: string;
  organizationId: string;
  content: Record<string, unknown>;
  publishAt?: Date | null;
  timezone?: string | null;
  requiresApproval?: boolean;
  allowDuplicate?: boolean;
  status: PostStatus;
  targets: readonly CreateTargetInput[];
  idempotencyKeyId?: string | null;
  createdByApiKeyId?: string | null;
  createdByUserId?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreatedPost {
  post: Post;
  targets: PostTarget[];
}

/**
 * Create a post and all its targets atomically.
 *
 * Called inside the same transaction as the idempotency reservation, so either the key,
 * the post and every target exist, or none of them do. A post with a missing target would
 * silently never publish to that destination.
 *
 * No provider call happens here (plan §24.1) — the transaction must not be held open
 * across a network call to a social network.
 */
export async function createPostWithTargets(
  tx: Database | Transaction,
  input: CreatePostWithTargetsInput,
): Promise<CreatedPost> {
  const postId = input.postId ?? newUuidV7();

  const [post] = await tx
    .insert(posts)
    .values({
      id: postId,
      profileId: input.profileId,
      projectEnvironmentId: input.projectEnvironmentId,
      projectId: input.projectId,
      organizationId: input.organizationId,
      status: input.status,
      content: input.content,
      publishAt: input.publishAt ?? null,
      timezone: input.timezone ?? null,
      requiresApproval: input.requiresApproval ?? false,
      allowDuplicate: input.allowDuplicate ?? false,
      idempotencyKeyId: input.idempotencyKeyId ?? null,
      createdByApiKeyId: input.createdByApiKeyId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata: input.metadata ?? {},
    })
    .returning();

  if (!post) throw new Error('Failed to insert post.');

  const targetRows = await tx
    .insert(postTargets)
    .values(
      input.targets.map((target) => ({
        id: newUuidV7(),
        postId,
        destinationId: target.destinationId,
        connectionId: target.connectionId,
        profileId: input.profileId,
        projectEnvironmentId: input.projectEnvironmentId,
        organizationId: input.organizationId,
        provider: target.provider,
        status: target.status ?? ('pending' as PostTargetStatus),
        overrides: target.overrides ?? null,
        options: target.options ?? null,
        contentFingerprint: target.contentFingerprint ?? null,
        maxAttempts: target.maxAttempts ?? 5,
      })),
    )
    .returning();

  return { post, targets: targetRows };
}

// ---------------------------------------------------------------------------
// Lease — ADR-006 Layer 2
// ---------------------------------------------------------------------------

export interface LeaseTargetInput {
  targetId: string;
  /** How long this worker may hold the target before another may take it over. */
  leaseSeconds?: number;
  now?: Date;
}

export interface LeaseResult {
  acquired: boolean;
  target?: PostTarget;
  leaseId?: string;
}

const DEFAULT_LEASE_SECONDS = 300;

/**
 * Try to acquire the exclusive right to publish one target.
 *
 * This single conditional UPDATE is what makes at-least-once queue delivery safe. A queue
 * message does not grant the right to publish — winning this statement does.
 *
 * `acquired: false` means another worker owns it, or it is already terminal. Either way
 * the caller must acknowledge the message and exit WITHOUT publishing. That is the
 * behaviour that prevents duplicate posts under redelivery.
 *
 * The `lease_expires_at < now()` clause makes a crashed worker self-healing: its lease
 * ages out and the next delivery can take over, with no operator intervention.
 */
export async function leaseTargetForExecution(
  db: Database,
  input: LeaseTargetInput,
): Promise<LeaseResult> {
  const now = input.now ?? new Date();
  const leaseId = newUuidV7();
  const leaseExpiresAt = new Date(now.getTime() + (input.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000);

  const [leased] = await db
    .update(postTargets)
    .set({
      status: 'publishing',
      leaseId,
      leaseExpiresAt,
      attemptCount: sql`${postTargets.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(postTargets.id, input.targetId),
        inArray(postTargets.status, ['queued', 'retryable_failed', 'scheduled']),
        or(isNull(postTargets.leaseExpiresAt), lt(postTargets.leaseExpiresAt, now)),
        // Respect the backoff schedule: a retryable target is not eligible until its
        // delay has elapsed.
        or(isNull(postTargets.nextAttemptAt), lt(postTargets.nextAttemptAt, now)),
        // Never exceed the attempt budget. Without this a permanently broken target
        // would be retried forever.
        sql`${postTargets.attemptCount} < ${postTargets.maxAttempts}`,
      ),
    )
    .returning();

  return leased ? { acquired: true, target: leased, leaseId } : { acquired: false };
}

/**
 * Release a lease without changing status — used when a worker decides not to proceed
 * (for example the rate limiter denied a permit) and wants the target retried promptly
 * rather than after the lease times out.
 */
export async function releaseTargetLease(
  db: Database,
  input: { targetId: string; leaseId: string; retryAt: Date; now?: Date },
): Promise<boolean> {
  const released = await db
    .update(postTargets)
    .set({
      status: 'queued',
      leaseId: null,
      leaseExpiresAt: null,
      nextAttemptAt: input.retryAt,
      // The attempt never happened, so it must not count against the budget.
      attemptCount: sql`GREATEST(${postTargets.attemptCount} - 1, 0)`,
      updatedAt: input.now ?? new Date(),
    })
    .where(and(eq(postTargets.id, input.targetId), eq(postTargets.leaseId, input.leaseId)))
    .returning({ id: postTargets.id });

  return released.length > 0;
}

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

export interface RecordAttemptInput {
  postTargetId: string;
  postId: string;
  attemptNumber: number;
  leaseId?: string | null;
  traceId?: string | null;
  startedAt?: Date;
}

/** Open an attempt record before calling the provider (plan §85 Rule 6). */
export async function startPublishAttempt(
  db: Database,
  input: RecordAttemptInput,
): Promise<{ attemptId: string }> {
  const attemptId = newUuidV7();

  await db
    .insert(postTargetAttempts)
    .values({
      id: attemptId,
      postTargetId: input.postTargetId,
      postId: input.postId,
      attemptNumber: input.attemptNumber,
      leaseId: input.leaseId ?? null,
      traceId: input.traceId ?? null,
      startedAt: input.startedAt ?? new Date(),
    })
    // A retried queue message may re-open the same attempt number. Harmless: the lease
    // already decided who may publish, so this only avoids a spurious constraint error.
    .onConflictDoNothing({
      target: [postTargetAttempts.postTargetId, postTargetAttempts.attemptNumber],
    });

  return { attemptId };
}

export interface FinishAttemptInput {
  attemptId: string;
  outcome: 'published' | 'provider_processing' | 'retryable_failed' | 'permanent_failed' | 'unknown_reconciliation_required' | 'skipped';
  providerPostId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  providerErrorSubcode?: string | null;
  providerStatus?: number | null;
  /** Already sanitized by @gs/observability (plan §7.2). */
  requestSummary?: Record<string, unknown> | null;
  responseSummary?: Record<string, unknown> | null;
  durationMs?: number;
  finishedAt?: Date;
}

export async function finishPublishAttempt(db: Database, input: FinishAttemptInput): Promise<void> {
  await db
    .update(postTargetAttempts)
    .set({
      outcome: input.outcome,
      providerPostId: input.providerPostId ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      providerErrorSubcode: input.providerErrorSubcode ?? null,
      providerStatus: input.providerStatus ?? null,
      requestSummary: input.requestSummary ?? null,
      responseSummary: input.responseSummary ?? null,
      durationMs: input.durationMs ?? null,
      finishedAt: input.finishedAt ?? new Date(),
    })
    .where(eq(postTargetAttempts.id, input.attemptId));
}

// ---------------------------------------------------------------------------
// Terminal outcomes
// ---------------------------------------------------------------------------

/**
 * Mark a target published.
 *
 * Guarded by `lease_id` so a stale worker whose lease expired — and whose target was
 * meanwhile taken over by another worker — cannot overwrite the newer outcome.
 */
export async function markTargetPublished(
  db: Database,
  input: {
    targetId: string;
    leaseId: string;
    providerPostId: string;
    providerPostUrl?: string | null;
    resolvedContent?: Record<string, unknown> | null;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();

  const updated = await db
    .update(postTargets)
    .set({
      status: 'published',
      providerPostId: input.providerPostId,
      providerPostUrl: input.providerPostUrl ?? null,
      resolvedContent: input.resolvedContent ?? null,
      publishedAt: now,
      leaseId: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      errorCode: null,
      errorMessage: null,
      retryable: null,
      updatedAt: now,
    })
    .where(and(eq(postTargets.id, input.targetId), eq(postTargets.leaseId, input.leaseId)))
    .returning({ id: postTargets.id });

  return updated.length > 0;
}

export async function markTargetRetryableFailure(
  db: Database,
  input: {
    targetId: string;
    leaseId: string;
    errorCode: string;
    errorMessage: string;
    providerErrorSubcode?: string | null;
    nextAttemptAt: Date;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();

  const updated = await db
    .update(postTargets)
    .set({
      status: 'retryable_failed',
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      providerErrorSubcode: input.providerErrorSubcode ?? null,
      retryable: true,
      nextAttemptAt: input.nextAttemptAt,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(postTargets.id, input.targetId), eq(postTargets.leaseId, input.leaseId)))
    .returning({ id: postTargets.id });

  return updated.length > 0;
}

export async function markTargetPermanentFailure(
  db: Database,
  input: {
    targetId: string;
    leaseId: string;
    errorCode: string;
    errorMessage: string;
    providerErrorSubcode?: string | null;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();

  const updated = await db
    .update(postTargets)
    .set({
      status: 'permanent_failed',
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      providerErrorSubcode: input.providerErrorSubcode ?? null,
      retryable: false,
      nextAttemptAt: null,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(postTargets.id, input.targetId), eq(postTargets.leaseId, input.leaseId)))
    .returning({ id: postTargets.id });

  return updated.length > 0;
}

/**
 * Park a target whose outcome is genuinely unknown (ADR-006 Layer 4).
 *
 * Deliberately NOT `retryable_failed`. A retry here is how duplicate posts get created —
 * the provider may have published successfully and lost the response. Reconciliation runs
 * first and only then decides.
 */
export async function markTargetReconciliationRequired(
  db: Database,
  input: {
    targetId: string;
    leaseId: string;
    errorCode: string;
    errorMessage: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();

  const updated = await db
    .update(postTargets)
    .set({
      status: 'unknown_reconciliation_required',
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      retryable: false,
      reconciliationRequiredAt: now,
      nextAttemptAt: null,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(postTargets.id, input.targetId), eq(postTargets.leaseId, input.leaseId)))
    .returning({ id: postTargets.id });

  return updated.length > 0;
}

/** Record that the provider accepted the content but is still processing it. */
export async function markTargetProviderProcessing(
  db: Database,
  input: { targetId: string; leaseId: string; providerPostId?: string | null; checkAt: Date; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();

  const updated = await db
    .update(postTargets)
    .set({
      status: 'provider_processing',
      providerPostId: input.providerPostId ?? null,
      nextAttemptAt: input.checkAt,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(postTargets.id, input.targetId), eq(postTargets.leaseId, input.leaseId)))
    .returning({ id: postTargets.id });

  return updated.length > 0;
}

/**
 * Record the provider-side ids that `prepare()` created, before anything is published
 * (ADR-006 Layer 4).
 *
 * Written in its own statement rather than folded into the publish transition, because the
 * whole point is that it must survive a publish that never returns. A container id learned
 * during preparation and lost when the worker died is exactly the information
 * reconciliation needs and cannot recover any other way.
 *
 * Lease-guarded like every other write in the execution path: a worker whose lease has
 * already been stolen must not overwrite the ids belonging to the attempt that replaced it.
 */
export async function recordPreparedProviderIds(
  db: Database,
  input: { targetId: string; leaseId: string; providerIds: readonly string[]; now?: Date },
): Promise<boolean> {
  // Nothing to record is the common case — most adapters and most posts prepare nothing.
  // Skipping the round trip keeps the publish path as short as it was.
  if (input.providerIds.length === 0) return true;

  const updated = await db
    .update(postTargets)
    .set({ preparedProviderIds: [...input.providerIds], updatedAt: input.now ?? new Date() })
    .where(and(eq(postTargets.id, input.targetId), eq(postTargets.leaseId, input.leaseId)))
    .returning({ id: postTargets.id });

  return updated.length > 0;
}

// ---------------------------------------------------------------------------
// Aggregate status — plan §78
// ---------------------------------------------------------------------------

export interface RecalculateResult {
  previousStatus: PostStatus;
  status: PostStatus;
  changed: boolean;
  targetStatuses: PostTargetStatus[];
}

/**
 * Recompute a post's status from its targets.
 *
 * Runs in a transaction that locks the post row first, so two workers finishing two
 * targets at the same instant cannot both read a stale set of statuses and race to write
 * conflicting aggregates. The lock is on the POST, not the targets — targets are already
 * serialized by their own leases.
 *
 * The reducer itself lives in `@gs/domain` and is pure, so its rules are testable without
 * a database.
 */
export async function recalculatePostStatus(
  db: Database,
  postId: string,
  now: Date = new Date(),
): Promise<RecalculateResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: posts.id, status: posts.status })
      .from(posts)
      .where(eq(posts.id, postId))
      .for('update')
      .limit(1);

    if (!current) throw new Error(`Post ${postId} not found while recalculating status.`);

    const rows = await tx
      .select({ status: postTargets.status })
      .from(postTargets)
      .where(eq(postTargets.postId, postId));

    const targetStatuses = rows.map((row) => row.status);
    const status = reducePostStatus(targetStatuses);
    const previousStatus = current.status;

    if (status === previousStatus) {
      return { previousStatus, status, changed: false, targetStatuses };
    }

    const isComplete =
      status === 'published' || status === 'partially_published' || status === 'failed';

    await tx
      .update(posts)
      .set({
        status,
        ...(isComplete ? { completedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(posts.id, postId));

    return { previousStatus, status, changed: true, targetStatuses };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getPostWithTargets(
  db: Database,
  postId: string,
): Promise<{ post: Post; targets: PostTarget[] } | null> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) return null;

  const targets = await db
    .select()
    .from(postTargets)
    .where(eq(postTargets.postId, postId))
    .orderBy(asc(postTargets.id));

  return { post, targets };
}

/**
 * Transition targets into the queue and return the ones that moved.
 *
 * Returns only rows that actually transitioned, so the caller enqueues exactly the
 * targets it just claimed — never a target another worker already dispatched.
 */
export async function enqueueTargets(
  db: Database,
  input: { postId: string; targetIds?: string[]; now?: Date },
): Promise<PostTarget[]> {
  const now = input.now ?? new Date();

  return db
    .update(postTargets)
    .set({ status: 'queued', nextAttemptAt: now, updatedAt: now })
    .where(
      and(
        eq(postTargets.postId, input.postId),
        input.targetIds?.length ? inArray(postTargets.id, input.targetIds) : undefined,
        inArray(postTargets.status, ['pending', 'scheduled', 'awaiting_approval']),
      ),
    )
    .returning();
}

/** Cancel every target that has not already reached a terminal state. */
export async function cancelPostTargets(
  db: Database,
  input: { postId: string; now?: Date },
): Promise<PostTarget[]> {
  const now = input.now ?? new Date();

  return db
    .update(postTargets)
    .set({
      status: 'cancelled',
      cancelledAt: now,
      leaseId: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(postTargets.postId, input.postId),
        // Deliberately excludes `publishing` and `provider_processing`: a call may
        // already be in flight at the provider, and marking it cancelled would lie about
        // an outcome we do not control.
        inArray(postTargets.status, ['pending', 'scheduled', 'queued', 'awaiting_approval', 'retryable_failed', 'blocked_validation']),
      ),
    )
    .returning();
}

/**
 * Requeue failed targets for retry (plan §26).
 *
 * `attempt_count` is reset because this is an explicit customer decision, not an
 * automatic retry — the budget that stopped automatic retries should not also block a
 * deliberate one.
 */
export async function requeueFailedTargets(
  db: Database,
  input: { postId: string; targetIds?: string[]; retryableOnly?: boolean; now?: Date },
): Promise<PostTarget[]> {
  const now = input.now ?? new Date();
  const statuses: PostTargetStatus[] = input.retryableOnly
    ? ['retryable_failed']
    : ['retryable_failed', 'permanent_failed'];

  return db
    .update(postTargets)
    .set({
      status: 'queued',
      nextAttemptAt: now,
      attemptCount: 0,
      errorCode: null,
      errorMessage: null,
      retryable: null,
      leaseId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(postTargets.postId, input.postId),
        input.targetIds?.length ? inArray(postTargets.id, input.targetIds) : undefined,
        inArray(postTargets.status, statuses),
      ),
    )
    .returning();
}

/**
 * Find targets whose lease expired while `publishing` — a worker died mid-flight.
 *
 * These are NOT simply requeued: the outcome is unknown, so they go to reconciliation
 * (ADR-006 Layer 4), the same treatment as a timeout.
 */
export async function findAbandonedTargets(
  db: Database,
  options: { now?: Date; limit?: number } = {},
): Promise<PostTarget[]> {
  const now = options.now ?? new Date();

  return db
    .select()
    .from(postTargets)
    .where(and(eq(postTargets.status, 'publishing'), lt(postTargets.leaseExpiresAt, now)))
    .orderBy(asc(postTargets.leaseExpiresAt))
    .limit(options.limit ?? 100);
}

/** Scheduled posts past their time with no live work — the Cron reconciler's input (plan §27). */
export async function findOverdueScheduledPosts(
  db: Database,
  options: { now?: Date; limit?: number } = {},
): Promise<Post[]> {
  const now = options.now ?? new Date();

  return db
    .select()
    .from(posts)
    .where(
      and(
        inArray(posts.status, ['scheduled', 'queued']),
        lt(posts.publishAt, now),
        sql`NOT EXISTS (
          SELECT 1 FROM ${postTargets}
          WHERE ${postTargets.postId} = ${posts.id}
            AND ${postTargets.status} IN ('publishing', 'provider_processing', 'preparing_media')
        )`,
      ),
    )
    .orderBy(asc(posts.publishAt))
    .limit(options.limit ?? 100);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface ListPostsInput {
  projectEnvironmentId: string;
  limit: number;
  order: 'asc' | 'desc';
  cursor?: string;
  profileId?: string;
  status?: PostStatus;
  restrictedToProfileId?: string | null;
}

export interface PostListRow {
  post: Post;
  targetCount: number;
  publishedTargetCount: number;
}

/**
 * A page of posts with rolled-up target counts.
 *
 * The counts come from a lateral aggregate rather than a second query per post: a page of
 * 25 posts would otherwise be 26 round trips, and a list view is the most-hit read in the
 * dashboard.
 */
export async function listPosts(
  db: Database,
  input: ListPostsInput,
): Promise<{ rows: PostListRow[]; hasMore: boolean }> {
  const conditions = [eq(posts.projectEnvironmentId, input.projectEnvironmentId)];

  if (input.profileId) conditions.push(eq(posts.profileId, input.profileId));
  if (input.status) conditions.push(eq(posts.status, input.status));
  // Enforced in SQL so a route cannot forget it (plan §38).
  if (input.restrictedToProfileId != null) {
    conditions.push(eq(posts.profileId, input.restrictedToProfileId));
  }
  if (input.cursor) {
    conditions.push(input.order === 'desc' ? lt(posts.id, input.cursor) : gt(posts.id, input.cursor));
  }

  const rows = await db
    .select({
      post: posts,
      targetCount: sql<number>`(
        select count(*)::int from ${postTargets} where ${postTargets.postId} = ${posts.id}
      )`,
      publishedTargetCount: sql<number>`(
        select count(*)::int from ${postTargets}
        where ${postTargets.postId} = ${posts.id} and ${postTargets.status} = 'published'
      )`,
    })
    .from(posts)
    .where(and(...conditions))
    .orderBy(input.order === 'desc' ? desc(posts.id) : asc(posts.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  return { rows: hasMore ? rows.slice(0, input.limit) : rows, hasMore };
}

// ---------------------------------------------------------------------------
// Reconciliation transitions — ADR-006 Layer 4
// ---------------------------------------------------------------------------

/**
 * Resolve a target out of `unknown_reconciliation_required`.
 *
 * Guarded by the *status* rather than by a lease, and that is deliberate. By the time
 * reconciliation runs the publishing lease is long released — the worker that timed out
 * is gone. Using a lease guard here would mean either resurrecting a dead lease or
 * passing an empty one, and the latter fails at the type level in Postgres.
 *
 * The status guard gives exactly the same protection: only one caller can win the
 * transition out of `unknown_reconciliation_required`, because the second finds nothing
 * to update. Two reconcilers racing therefore produce one outcome, not two.
 */
export async function resolveReconciliation(
  db: Database,
  input: {
    targetId: string;
    outcome: 'published' | 'retryable_failed' | 'permanent_failed';
    providerPostId?: string | null;
    providerPostUrl?: string | null;
    publishedAt?: Date | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    nextAttemptAt?: Date | null;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();

  const updated = await db
    .update(postTargets)
    .set({
      status: input.outcome,
      providerPostId: input.providerPostId ?? null,
      providerPostUrl: input.providerPostUrl ?? null,
      publishedAt: input.outcome === 'published' ? (input.publishedAt ?? now) : null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      nextAttemptAt: input.nextAttemptAt ?? null,
      leaseId: null,
      leaseExpiresAt: null,
      reconciledAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(postTargets.id, input.targetId),
        eq(postTargets.status, 'unknown_reconciliation_required'),
      ),
    )
    .returning({ id: postTargets.id });

  return updated.length > 0;
}
