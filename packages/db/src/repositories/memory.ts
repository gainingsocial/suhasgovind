import { newUuidV7 } from '@gs/contracts/ids';
import type { PostSample, PerformanceObservation } from '@gs/domain';
import { and, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { analyticsSnapshots, externalPosts } from '../schema/analytics.js';
import {
  brandMemoryEntries,
  performanceObservations,
  type BrandMemoryEntry,
  type BrandMemoryKind,
  type PerformanceObservationRow,
} from '../schema/memory.js';

/**
 * Social memory repository (plan Phase 10, §76).
 *
 * The interesting operation is `loadPostSamples`. Everything else is storage; that one is
 * the join that turns "we have analytics" into "we can learn something", and it has two
 * decisions in it.
 *
 * It reads the *latest* snapshot per post, not every snapshot. Engagement is cumulative,
 * so summing snapshots would count the same like once per observation and rank a post that
 * was polled often above one that was not.
 *
 * It only considers posts old enough to have finished accumulating. A post published an
 * hour ago has not underperformed — nobody has seen it yet — and including it drags every
 * recent bucket down and produces the confident, wrong conclusion that whatever the
 * customer just started doing is not working.
 */

// ---- brand memory ----------------------------------------------------------

export interface UpsertBrandMemoryInput {
  profileId: string;
  projectEnvironmentId: string;
  organizationId: string;
  kind: BrandMemoryKind;
  label: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Record a brand fact, replacing one with the same label.
 *
 * Upsert rather than insert, because a customer correcting a product description is
 * editing a fact, not asserting a second one.
 */
export async function upsertBrandMemory(
  db: Database,
  input: UpsertBrandMemoryInput,
): Promise<BrandMemoryEntry> {
  const rows = await db
    .insert(brandMemoryEntries)
    .values({
      id: newUuidV7(),
      profileId: input.profileId,
      projectEnvironmentId: input.projectEnvironmentId,
      organizationId: input.organizationId,
      kind: input.kind,
      label: input.label,
      labelKey: input.label.trim().toLowerCase(),
      body: input.body ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [brandMemoryEntries.profileId, brandMemoryEntries.kind, brandMemoryEntries.labelKey],
      set: {
        body: sql`excluded.body`,
        metadata: sql`excluded.metadata`,
        // The display label is refreshed so a change of capitalization is honoured — the
        // uniqueness is case-insensitive, the stored value is what the customer typed.
        label: sql`excluded.label`,
        updatedAt: new Date(),
      },
    })
    .returning();

  return rows[0]!;
}

export async function listBrandMemory(
  db: Database,
  projectEnvironmentId: string,
  profileId: string,
  kind?: BrandMemoryKind,
): Promise<BrandMemoryEntry[]> {
  const conditions = [
    eq(brandMemoryEntries.profileId, profileId),
    eq(brandMemoryEntries.projectEnvironmentId, projectEnvironmentId),
  ];
  if (kind) conditions.push(eq(brandMemoryEntries.kind, kind));

  return db
    .select()
    .from(brandMemoryEntries)
    .where(and(...conditions))
    .orderBy(brandMemoryEntries.kind, brandMemoryEntries.label);
}

/**
 * Forget a brand fact.
 *
 * A hard delete, unlike almost everything else here. A customer who tells us to forget
 * that a competitor exists means it, and a soft-deleted row that a generation step could
 * still read would make the instruction a suggestion.
 */
export async function deleteBrandMemory(
  db: Database,
  projectEnvironmentId: string,
  entryId: string,
): Promise<boolean> {
  const rows = await db
    .delete(brandMemoryEntries)
    .where(
      and(
        eq(brandMemoryEntries.id, entryId),
        eq(brandMemoryEntries.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .returning({ id: brandMemoryEntries.id });

  return rows.length > 0;
}

// ---- performance memory ----------------------------------------------------

/**
 * How long a post is given before its numbers count.
 *
 * Two days. Most networks are still delivering a post 24 hours in, and several report
 * impressions on a lag of their own — `provider_data_as_of` exists precisely because the
 * numbers we hold trail reality.
 */
export const SETTLING_HOURS = 48;

export interface LoadPostSamplesInput {
  projectEnvironmentId: string;
  profileId: string;
  /** How far back to learn from. Older content reflects an audience that has moved on. */
  since: Date;
  /** Posts published after this are still accumulating and are excluded. */
  settledBefore: Date;
}

export async function loadPostSamples(
  db: Database,
  input: LoadPostSamplesInput,
): Promise<PostSample[]> {
  /**
   * The latest snapshot per post.
   *
   * `DISTINCT ON` rather than a window function or a correlated subquery: Postgres reads
   * it straight off the `(external_post_id, observed_at DESC)` index that already exists
   * for the freshness sweep, so this costs one index scan rather than a sort per post.
   */
  const latest = db
    .selectDistinctOn([analyticsSnapshots.externalPostId], {
      externalPostId: analyticsSnapshots.externalPostId,
      impressions: analyticsSnapshots.impressions,
      engagements: analyticsSnapshots.engagements,
      likes: analyticsSnapshots.likes,
      comments: analyticsSnapshots.comments,
      shares: analyticsSnapshots.shares,
    })
    .from(analyticsSnapshots)
    .where(eq(analyticsSnapshots.projectEnvironmentId, input.projectEnvironmentId))
    .orderBy(analyticsSnapshots.externalPostId, desc(analyticsSnapshots.observedAt))
    .as('latest');

  const rows = await db
    .select({
      provider: externalPosts.provider,
      postType: externalPosts.postType,
      publishedAt: externalPosts.publishedAt,
      impressions: latest.impressions,
      engagements: latest.engagements,
      likes: latest.likes,
      comments: latest.comments,
      shares: latest.shares,
    })
    .from(externalPosts)
    .innerJoin(latest, eq(latest.externalPostId, externalPosts.id))
    .where(
      and(
        eq(externalPosts.projectEnvironmentId, input.projectEnvironmentId),
        eq(externalPosts.profileId, input.profileId),
        isNotNull(externalPosts.publishedAt),
        gte(externalPosts.publishedAt, input.since),
        // `lte`, not a raw `sql` template.
        //
        // The typed comparison helpers know the column is a timestamp and encode a `Date`
        // the way the driver expects. A raw template does not: it binds the JS `Date`
        // object straight through, and postgres.js rejects it with "the string argument
        // must be of type string ... received an instance of Date". Every call to
        // `POST /v1/memory/learn` failed with a 500 on this line, which is also why the
        // sibling `gte` above — one line away, same value type — always worked.
        lte(externalPosts.publishedAt, input.settledBefore),
        // A deleted post's numbers describe content nobody can see. Learning from it would
        // recommend repeating something that no longer exists.
        sql`${externalPosts.deletedDetectedAt} IS NULL`,
      ),
    );

  return rows.map((row) => ({
    provider: row.provider,
    format: row.postType,
    publishedAt: row.publishedAt!,
    /**
     * Several providers report the components but not the total. Falling back to their sum
     * is better than discarding the post, and it is the same definition of engagement the
     * analytics normalizer uses.
     */
    engagements:
      row.engagements ??
      (row.likes === null && row.comments === null && row.shares === null
        ? null
        : (row.likes ?? 0) + (row.comments ?? 0) + (row.shares ?? 0)),
    impressions: row.impressions,
  }));
}

export interface ReplaceObservationsInput {
  profileId: string;
  projectEnvironmentId: string;
  organizationId: string;
  windowStart: Date;
  windowEnd: Date;
  observations: readonly PerformanceObservation[];
}

/**
 * Replace this profile's performance memory with a freshly computed set.
 *
 * Delete-then-insert inside one transaction rather than upserting row by row. A bucket that
 * no longer clears the minimum sample size — because posts aged out of the window — has to
 * *disappear*, and an upsert would leave it there indefinitely, quietly stale.
 */
export async function replaceObservations(
  db: Database,
  input: ReplaceObservationsInput,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .delete(performanceObservations)
      .where(
        and(
          eq(performanceObservations.profileId, input.profileId),
          eq(performanceObservations.projectEnvironmentId, input.projectEnvironmentId),
        ),
      );

    if (input.observations.length === 0) return 0;

    await tx.insert(performanceObservations).values(
      input.observations.map((observation) => ({
        id: newUuidV7(),
        profileId: input.profileId,
        projectEnvironmentId: input.projectEnvironmentId,
        organizationId: input.organizationId,
        provider: observation.provider,
        dimension: observation.dimension,
        bucket: observation.bucket,
        sampleSize: observation.sampleSize,
        bucketMean: observation.bucketMean,
        baselineMean: observation.baselineMean,
        lift: observation.lift,
        metric: observation.metric,
        confidence: observation.confidence,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
      })),
    );

    return input.observations.length;
  });
}

export async function listObservations(
  db: Database,
  projectEnvironmentId: string,
  profileId: string,
): Promise<PerformanceObservationRow[]> {
  return db
    .select()
    .from(performanceObservations)
    .where(
      and(
        eq(performanceObservations.profileId, profileId),
        eq(performanceObservations.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .orderBy(desc(performanceObservations.sampleSize));
}
