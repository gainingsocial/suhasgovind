import { newUuidV7 } from '@gs/contracts/ids';
import type { MetricValues } from '@gs/domain';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import {
  analyticsSnapshots,
  externalPosts,
  type AnalyticsSnapshot,
  type ExternalPost,
} from '../schema/analytics.js';

/**
 * Analytics persistence (plan Phase 6).
 *
 * Reads always come from stored snapshots. Nothing here calls a provider — that happens on
 * a schedule, in a worker, against a rate-limit budget publishing also depends on.
 */

export interface UpsertExternalPostInput {
  destinationId: string;
  profileId: string;
  projectEnvironmentId: string;
  organizationId: string;
  provider: string;
  externalPostId: string;
  externalUrl?: string | null;
  postTargetId?: string | null;
  postId?: string | null;
  postType?: string | null;
  excerpt?: string | null;
  publishedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

/**
 * Record a post seen on a platform.
 *
 * Upsert on `(destination, external id)`, because discovery is at-least-once: a sync
 * re-reads a window that overlaps the previous one, so the same post arrives repeatedly and
 * without this every engagement figure would be counted once per sync.
 *
 * `post_target_id` is only ever *added*, never cleared. A later discovery pass that finds
 * the same post without knowing we published it must not sever the link back to the post
 * that created it.
 */
export async function upsertExternalPost(
  db: Database,
  input: UpsertExternalPostInput,
): Promise<{ id: string; created: boolean }> {
  const id = newUuidV7();

  const rows = await db
    .insert(externalPosts)
    .values({
      id,
      destinationId: input.destinationId,
      profileId: input.profileId,
      projectEnvironmentId: input.projectEnvironmentId,
      organizationId: input.organizationId,
      provider: input.provider,
      externalPostId: input.externalPostId,
      externalUrl: input.externalUrl ?? null,
      postTargetId: input.postTargetId ?? null,
      postId: input.postId ?? null,
      postType: input.postType ?? null,
      excerpt: input.excerpt ?? null,
      publishedAt: input.publishedAt ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [externalPosts.destinationId, externalPosts.externalPostId],
      set: {
        externalUrl: sql`coalesce(${externalPosts.externalUrl}, excluded.external_url)`,
        postTargetId: sql`coalesce(${externalPosts.postTargetId}, excluded.post_target_id)`,
        postId: sql`coalesce(${externalPosts.postId}, excluded.post_id)`,
        postType: sql`coalesce(excluded.post_type, ${externalPosts.postType})`,
        excerpt: sql`coalesce(excluded.excerpt, ${externalPosts.excerpt})`,
        publishedAt: sql`coalesce(${externalPosts.publishedAt}, excluded.published_at)`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: externalPosts.id });

  const row = rows[0]!;
  return { id: row.id, created: row.id === id };
}

export interface RecordSnapshotInput {
  externalPostId: string;
  destinationId: string;
  projectEnvironmentId: string;
  provider: string;
  metrics: MetricValues;
  nativeMetrics?: Record<string, unknown>;
  observedAt?: Date;
  providerDataAsOf?: Date | null;
  nextExpectedRefresh?: Date | null;
}

/**
 * Append one reading.
 *
 * Never an update. A provider revising a number downward has to be visible as a revision
 * rather than as silent data loss, and the shape of a post's engagement curve is the thing
 * that decides what to publish next.
 */
export async function recordAnalyticsSnapshot(
  db: Database,
  input: RecordSnapshotInput,
): Promise<string> {
  const id = newUuidV7();

  await db.insert(analyticsSnapshots).values({
    id,
    externalPostId: input.externalPostId,
    destinationId: input.destinationId,
    projectEnvironmentId: input.projectEnvironmentId,
    provider: input.provider,
    observedAt: input.observedAt ?? new Date(),
    providerDataAsOf: input.providerDataAsOf ?? null,
    nextExpectedRefresh: input.nextExpectedRefresh ?? null,
    impressions: input.metrics.impressions ?? null,
    reach: input.metrics.reach ?? null,
    views: input.metrics.views ?? null,
    likes: input.metrics.likes ?? null,
    comments: input.metrics.comments ?? null,
    shares: input.metrics.shares ?? null,
    saves: input.metrics.saves ?? null,
    clicks: input.metrics.clicks ?? null,
    engagements: input.metrics.engagements ?? null,
    watchTimeSeconds: input.metrics.watch_time_seconds ?? null,
    followersDelta: input.metrics.followers_delta ?? null,
    nativeMetrics: input.nativeMetrics ?? {},
  });

  return id;
}

/** The most recent reading for a post. What a dashboard shows. */
export async function findLatestSnapshot(
  db: Database,
  externalPostId: string,
): Promise<AnalyticsSnapshot | null> {
  const rows = await db
    .select()
    .from(analyticsSnapshots)
    .where(eq(analyticsSnapshots.externalPostId, externalPostId))
    .orderBy(desc(analyticsSnapshots.observedAt))
    .limit(1);

  return rows[0] ?? null;
}

/** The full series, for a chart of how a post performed over time. */
export async function listSnapshots(
  db: Database,
  externalPostId: string,
  limit: number,
): Promise<AnalyticsSnapshot[]> {
  return db
    .select()
    .from(analyticsSnapshots)
    .where(eq(analyticsSnapshots.externalPostId, externalPostId))
    .orderBy(desc(analyticsSnapshots.observedAt))
    .limit(limit);
}

export async function findExternalPostById(
  db: Database,
  projectEnvironmentId: string,
  externalPostRowId: string,
): Promise<ExternalPost | null> {
  const rows = await db
    .select()
    .from(externalPosts)
    .where(
      and(
        eq(externalPosts.id, externalPostRowId),
        eq(externalPosts.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export interface ListExternalPostsInput {
  projectEnvironmentId: string;
  profileId?: string | null;
  destinationId?: string | null;
  provider?: string | null;
  publishedFrom?: Date | null;
  publishedTo?: Date | null;
  limit: number;
}

export async function listExternalPosts(
  db: Database,
  input: ListExternalPostsInput,
): Promise<ExternalPost[]> {
  const conditions = [
    eq(externalPosts.projectEnvironmentId, input.projectEnvironmentId),
    // Posts the platform no longer shows are excluded by default. A chart including
    // deleted posts reports engagement nobody can go and look at.
    isNull(externalPosts.deletedDetectedAt),
  ];

  if (input.profileId) conditions.push(eq(externalPosts.profileId, input.profileId));
  if (input.destinationId) conditions.push(eq(externalPosts.destinationId, input.destinationId));
  if (input.provider) conditions.push(eq(externalPosts.provider, input.provider));
  if (input.publishedFrom) conditions.push(gte(externalPosts.publishedAt, input.publishedFrom));
  if (input.publishedTo) conditions.push(lte(externalPosts.publishedAt, input.publishedTo));

  return db
    .select()
    .from(externalPosts)
    .where(and(...conditions))
    .orderBy(desc(externalPosts.publishedAt))
    .limit(input.limit);
}

/**
 * Posts whose metrics are due another look.
 *
 * Driven by `next_expected_refresh` on the most recent snapshot, plus anything never
 * observed at all. A post with no snapshot is genuinely urgent — it is the one nobody has
 * looked at — so it sorts first rather than being missed by a query that only knows how to
 * find stale rows.
 */
export async function findPostsDueForRefresh(
  db: Database,
  limit: number,
  now: Date = new Date(),
): Promise<ExternalPost[]> {
  const latest = db
    .select({
      externalPostId: analyticsSnapshots.externalPostId,
      nextRefresh: sql<Date | null>`max(${analyticsSnapshots.nextExpectedRefresh})`.as(
        'next_refresh',
      ),
    })
    .from(analyticsSnapshots)
    .groupBy(analyticsSnapshots.externalPostId)
    .as('latest');

  const rows = await db
    .select({ post: externalPosts })
    .from(externalPosts)
    .leftJoin(latest, eq(latest.externalPostId, externalPosts.id))
    .where(
      and(
        isNull(externalPosts.deletedDetectedAt),
        /**
         * Never observed, or observed and now due.
         *
         * The bound value is an ISO string cast in SQL, not a `Date`. A raw template binds
         * a JS Date through the driver's own serializer, which rejects it outright here —
         * the same trap `acquireRefreshLock` documents, and the reason typed helpers are
         * preferred everywhere a comparison can be expressed with them. This one cannot,
         * because the column belongs to a subquery alias.
         */
        sql`(${latest.nextRefresh} IS NULL OR ${latest.nextRefresh} <= ${now.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(sql`${latest.nextRefresh} ASC NULLS FIRST`)
    .limit(limit);

  return rows.map((row) => row.post);
}

/** Mark a post the platform no longer shows. */
export async function markExternalPostDeleted(
  db: Database,
  externalPostRowId: string,
): Promise<void> {
  await db
    .update(externalPosts)
    .set({ deletedDetectedAt: new Date(), updatedAt: new Date() })
    .where(eq(externalPosts.id, externalPostRowId));
}

export interface AnalyticsTotals {
  posts: number;
  impressions: number | null;
  reach: number | null;
  engagements: number | null;
}

/**
 * Totals across a profile's posts, from the latest snapshot of each.
 *
 * `DISTINCT ON` rather than an aggregate over every snapshot: summing the whole series
 * would count each post once per reading, which turns a post observed twenty times into
 * twenty posts' worth of impressions.
 */
export async function summarizeProfileAnalytics(
  db: Database,
  input: { projectEnvironmentId: string; profileId?: string | null },
): Promise<AnalyticsTotals> {
  const scope = input.profileId
    ? sql`and p.profile_id = ${input.profileId}`
    : sql``;

  const rows = await db.execute<{
    posts: string;
    impressions: string | null;
    reach: string | null;
    engagements: string | null;
  }>(sql`
    with latest as (
      select distinct on (s.external_post_id)
        s.external_post_id, s.impressions, s.reach, s.engagements
      from analytics_snapshots s
      join external_posts p on p.id = s.external_post_id
      where p.project_environment_id = ${input.projectEnvironmentId}
        and p.deleted_detected_at is null
        ${scope}
      order by s.external_post_id, s.observed_at desc
    )
    select
      count(*)::text as posts,
      sum(impressions)::text as impressions,
      sum(reach)::text as reach,
      sum(engagements)::text as engagements
    from latest
  `);

  const row = rows[0];

  return {
    posts: Number(row?.posts ?? 0),
    // Null rather than zero when nothing is known. A total of 0 and "no data yet" look
    // identical on a dashboard and mean opposite things.
    impressions: row?.impressions === null || row?.impressions === undefined ? null : Number(row.impressions),
    reach: row?.reach === null || row?.reach === undefined ? null : Number(row.reach),
    engagements:
      row?.engagements === null || row?.engagements === undefined ? null : Number(row.engagements),
  };
}
