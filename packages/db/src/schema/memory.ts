import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { organizations, profiles, projectEnvironments } from './tenancy.js';

/**
 * Social memory (plan Phase 10).
 *
 * Two kinds, and the difference is the point.
 *
 * Brand memory is *asserted* by the customer and never inferred. A brand that has said it
 * will not claim "the fastest" does not get overruled because a post making that claim
 * performed well.
 *
 * Performance memory is *derived* from analytics we already collect, rebuilt rather than
 * edited, and every row carries the sample size it rests on. A learning from three posts is
 * noise wearing a hat.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const BRAND_MEMORY_KINDS = [
  'product',
  'audience',
  'competitor',
  'vocabulary',
  'campaign',
  'faq',
  'banned_claim',
] as const;
export type BrandMemoryKind = (typeof BRAND_MEMORY_KINDS)[number];

/**
 * A fact the customer told us about their brand.
 *
 * Typed rather than free-form so a generation step can ask for exactly the kind it needs —
 * the banned claims, or the product names — instead of receiving a wall of notes and
 * hoping the model reads the right part of it.
 */
export const brandMemoryEntries = pgTable(
  'brand_memory_entries',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    kind: text('kind').$type<BrandMemoryKind>().notNull(),
    /** The product's name, the competitor's name, the question a FAQ answers. As typed. */
    label: text('label').notNull(),
    /**
     * The same label, lowercased and trimmed, and what uniqueness is enforced on.
     *
     * A stored column rather than a `lower(label)` expression index, because the upsert has
     * to name its conflict target and a query builder can only name a column. The display
     * casing survives; "Pro plan" and "pro plan" still collide.
     */
    labelKey: text('label_key').notNull(),
    /** The substance. For a FAQ this is the answer; for a banned claim, the claim. */
    body: text('body'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index('brand_memory_entries_profile_kind_idx').on(table.profileId, table.kind),
    /**
     * One label per kind per profile, case-insensitively. Two rows both called "Pro plan"
     * is somebody editing the same fact twice, not two products, and a generation step
     * handed both would have to pick one.
     */
    uniqueIndex('brand_memory_entries_profile_kind_label_key').on(
      table.profileId,
      table.kind,
      table.labelKey,
    ),
  ],
);

/**
 * What we have learned about how this profile's content performs.
 *
 * Rebuilt, not appended: a learning pass replaces the row for a bucket rather than adding
 * a second one, so a reader never has to work out which of five rows is current.
 */
export const performanceObservations = pgTable(
  'performance_observations',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    /** Never aggregated across networks — a video on TikTok and on LinkedIn share a word. */
    provider: text('provider').notNull(),
    /** `format`, `posting_hour`, `posting_weekday`. */
    dimension: text('dimension').notNull(),
    bucket: text('bucket').notNull(),

    /** Surfaced in the API, because a lift computed from four posts is not a finding. */
    sampleSize: integer('sample_size').notNull(),
    bucketMean: doublePrecision('bucket_mean').notNull(),
    baselineMean: doublePrecision('baseline_mean').notNull(),
    lift: doublePrecision('lift').notNull(),
    /** `engagement_rate` or `engagements` — a rate and a count are not comparable. */
    metric: text('metric').notNull(),
    /** Derived from sample size alone. Nothing here claims significance it has not tested. */
    confidence: text('confidence').$type<'low' | 'medium' | 'high'>().notNull(),

    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('performance_observations_key').on(
      table.profileId,
      table.provider,
      table.dimension,
      table.bucket,
    ),
    index('performance_observations_profile_idx').on(table.profileId, table.computedAt.desc()),
  ],
);

export type BrandMemoryEntry = typeof brandMemoryEntries.$inferSelect;
export type PerformanceObservationRow = typeof performanceObservations.$inferSelect;
