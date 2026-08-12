import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { socialDestinations } from './connections.js';
import { postTargets, posts } from './posts.js';
import { organizations, profiles, projectEnvironments } from './tenancy.js';

/**
 * Analytics and external post normalization (plan Phase 6).
 *
 * Two rules govern the whole design.
 *
 * **Never query a provider live for a dashboard load.** Plan Phase 6 says so outright, and
 * the reason is arithmetic: a customer with forty connected accounts opening an overview
 * page would fire forty provider calls, exhaust a rate limit that publishing also depends
 * on, and take twelve seconds to render a number that was good enough an hour ago.
 *
 * **Never imply analytics is real-time when it is not.** Every snapshot carries when we
 * observed it, what the provider said it was as of, and when we will look again. Those are
 * three different moments and collapsing them is how a customer concludes their post got
 * no engagement when in truth nobody has asked yet.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * A post on a platform, whether or not we published it (plan Phase 6).
 *
 * Discovering posts made outside this system is what makes the analytics useful rather than
 * partial: a brand's account has history, and an overview that silently omits everything
 * posted before they signed up — or from the platform's own app since — is a chart that
 * misleads by construction.
 *
 * `post_target_id` links back when we were the publisher. NULL means somebody posted it
 * another way, and that is a normal, permanent state rather than a gap to fill.
 */
export const externalPosts = pgTable(
  'external_posts',
  {
    id: uuid('id').primaryKey(),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => socialDestinations.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),

    /** The provider's own id. The join key for every later analytics fetch. */
    externalPostId: text('external_post_id').notNull(),
    externalUrl: text('external_url'),

    /** Set when this system published it. NULL for a post discovered on the platform. */
    postTargetId: uuid('post_target_id').references(() => postTargets.id, { onDelete: 'set null' }),
    postId: uuid('post_id').references(() => posts.id, { onDelete: 'set null' }),

    /** `image`, `video`, `carousel`, `reel`, `story`, `text`. Provider vocabulary normalized. */
    postType: text('post_type'),
    /** Excerpt only. We are not a content archive, and storing full copies of a customer's
     *  posts indefinitely is a data-retention liability nobody asked us to take on. */
    excerpt: text('excerpt'),

    /** The provider's own timestamp, not when we found it (Rule 15). */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the post is no longer visible on the platform. */
    deletedDetectedAt: timestamp('deleted_detected_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    /**
     * One row per provider post per destination.
     *
     * Discovery is at-least-once — a sync re-reads a window that overlaps the last one —
     * so without this a weekly sync would accumulate a duplicate of every post it saw
     * twice, and every engagement number would be double-counted.
     */
    uniqueIndex('external_posts_destination_external_key').on(
      table.destinationId,
      table.externalPostId,
    ),
    index('external_posts_profile_published_idx').on(table.profileId, table.publishedAt.desc()),
    index('external_posts_environment_idx').on(table.projectEnvironmentId),
    index('external_posts_target_idx')
      .on(table.postTargetId)
      .where(sql`${table.postTargetId} IS NOT NULL`),
  ],
);

/**
 * One reading of one post's metrics at one moment (plan Phase 6).
 *
 * Append-only snapshots rather than a mutable row of current values. Engagement is a curve,
 * not a number: "did the reel keep gaining views after day two" is the question that
 * decides what to post next, and overwriting yesterday's figure makes it unanswerable.
 * It also means a provider revising a number downward — which they do — is visible as a
 * revision rather than as silent data loss.
 */
export const analyticsSnapshots = pgTable(
  'analytics_snapshots',
  {
    id: uuid('id').primaryKey(),
    externalPostId: uuid('external_post_id')
      .notNull()
      .references(() => externalPosts.id, { onDelete: 'cascade' }),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => socialDestinations.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),

    /**
     * The three timestamps plan Phase 6 requires, and they are genuinely different.
     *
     * `observed_at`          when we asked
     * `provider_data_as_of`  what the provider said the numbers were current as of, which
     *                        on most platforms lags by hours
     * `next_expected_refresh` when we will ask again
     *
     * Collapsing them is how a customer concludes their post got no engagement when in
     * truth nobody has looked yet.
     */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    providerDataAsOf: timestamp('provider_data_as_of', { withTimezone: true }),
    nextExpectedRefresh: timestamp('next_expected_refresh', { withTimezone: true }),

    /**
     * Normalized metrics, `bigint` because a viral post outgrows an int32 and discovering
     * that in production means silently wrong numbers rather than an error.
     */
    impressions: bigint('impressions', { mode: 'number' }),
    reach: bigint('reach', { mode: 'number' }),
    views: bigint('views', { mode: 'number' }),
    likes: bigint('likes', { mode: 'number' }),
    comments: bigint('comments', { mode: 'number' }),
    shares: bigint('shares', { mode: 'number' }),
    saves: bigint('saves', { mode: 'number' }),
    clicks: bigint('clicks', { mode: 'number' }),
    engagements: bigint('engagements', { mode: 'number' }),
    watchTimeSeconds: bigint('watch_time_seconds', { mode: 'number' }),
    followersDelta: bigint('followers_delta', { mode: 'number' }),

    /**
     * Everything the provider returned that has no normalized home (plan §43, Phase 6).
     *
     * Kept because a normalized model that drops what it does not recognize is a model
     * that quietly loses the metric a customer's whole strategy depends on. Namespaced by
     * provider so two platforms' `plays` cannot collide.
     */
    nativeMetrics: jsonb('native_metrics').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('analytics_snapshots_post_observed_idx').on(
      table.externalPostId,
      table.observedAt.desc(),
    ),
    index('analytics_snapshots_environment_observed_idx').on(
      table.projectEnvironmentId,
      table.observedAt.desc(),
    ),
    /** Drives the freshness sweep: which posts are due another look. */
    index('analytics_snapshots_due_idx')
      .on(table.nextExpectedRefresh)
      .where(sql`${table.nextExpectedRefresh} IS NOT NULL`),
  ],
);

export const externalPostsRelations = relations(externalPosts, ({ one, many }) => ({
  destination: one(socialDestinations, {
    fields: [externalPosts.destinationId],
    references: [socialDestinations.id],
  }),
  target: one(postTargets, {
    fields: [externalPosts.postTargetId],
    references: [postTargets.id],
  }),
  snapshots: many(analyticsSnapshots),
}));

export const analyticsSnapshotsRelations = relations(analyticsSnapshots, ({ one }) => ({
  post: one(externalPosts, {
    fields: [analyticsSnapshots.externalPostId],
    references: [externalPosts.id],
  }),
}));

export type ExternalPost = typeof externalPosts.$inferSelect;
export type AnalyticsSnapshot = typeof analyticsSnapshots.$inferSelect;
