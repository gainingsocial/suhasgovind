import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { socialDestinations } from './connections.js';
import { posts } from './posts.js';
import { organizations, profiles, projectEnvironments } from './tenancy.js';

/**
 * Content Intelligence and universal repurposing (plan Phase 4B, §63F–63Q).
 *
 * These tables were created by migration 0010 and then had no Drizzle definitions, which
 * meant nothing could read or write them: the schema existed, the domain logic for
 * grounding and injection defence existed, and there was no route in between. This file is
 * the missing half.
 *
 * Three invariants are structural rather than conventional, and each has a comment where
 * it is expressed:
 *
 *   versions are append-only   an extraction is only valid for the exact text it read
 *   drafts start unapproved    P20 — automation defaults to review
 *   grounding is recorded      P18 — a claim is traceable to spans, or it is flagged
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const CONTENT_SOURCE_KINDS = ['url', 'rss', 'upload', 'text'] as const;
export type ContentSourceKind = (typeof CONTENT_SOURCE_KINDS)[number];

export const AUTOMATION_MODES = ['draft_only', 'approval_required', 'auto_publish_if_safe'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const DRAFT_SET_STATUSES = [
  'draft',
  'ready_for_review',
  'approved',
  'published',
  'discarded',
] as const;
export type DraftSetStatus = (typeof DRAFT_SET_STATUSES)[number];

/**
 * Something a customer wants turned into social posts: a page, a feed, an upload, or text
 * pasted straight in. Discovery differs per kind; everything downstream does not.
 */
export const contentSources = pgTable(
  'content_sources',
  {
    id: uuid('id').primaryKey(),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }),

    kind: text('kind').$type<ContentSourceKind>().notNull(),
    url: text('url'),
    name: text('name'),
    /** Defaults to `approval_required` per P20 — the database default, not just the API's. */
    automationMode: text('automation_mode')
      .$type<AutomationMode>()
      .notNull()
      .default('approval_required'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    nextFetchAt: timestamp('next_fetch_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index('content_sources_environment_idx').on(table.projectEnvironmentId),
    index('content_sources_due_idx')
      .on(table.nextFetchAt)
      .where(sql`disabled_at IS NULL AND next_fetch_at IS NOT NULL`),
  ],
);

/** One discovered thing within a source — an article in a feed, the page itself. */
export const sourceItems = pgTable(
  'source_items',
  {
    id: uuid('id').primaryKey(),
    contentSourceId: uuid('content_source_id')
      .notNull()
      .references(() => contentSources.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    url: text('url'),
    title: text('title'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    /**
     * A feed re-read hourly returns the same items. Without this, each read would create a
     * new item and generate a fresh set of drafts for content nobody republished.
     */
    uniqueIndex('source_items_source_external_key').on(table.contentSourceId, table.externalId),
  ],
);

/**
 * A version of an item's text. Append-only.
 *
 * Span ids are positional and stable only *within* a version, so a claim grounded in span
 * 12 of yesterday's article is not grounded in span 12 of today's. Overwriting a source
 * would silently re-point every existing citation at different words, which is precisely
 * the failure P18 exists to prevent.
 */
export const sourceItemVersions = pgTable(
  'source_item_versions',
  {
    id: uuid('id').primaryKey(),
    sourceItemId: uuid('source_item_id')
      .notNull()
      .references(() => sourceItems.id, { onDelete: 'cascade' }),
    /** SHA-256 of the normalized text. Unchanged content is never re-analyzed (§63R). */
    contentHash: text('content_hash').notNull(),
    normalizedText: text('normalized_text').notNull(),
    /** As produced by `splitIntoSpans`: id, text, and offsets into the normalized text. */
    spans: jsonb('spans')
      .$type<{ id: string; text: string; start: number; end: number }[]>()
      .notNull()
      .default([]),
    /**
     * True when the ingested text pattern-matched a prompt-injection attempt (§63S). A
     * signal for review, never a gate: detection is the weakest of the three defences.
     */
    injectionSuspected: boolean('injection_suspected').notNull().default(false),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('source_item_versions_item_hash_key').on(table.sourceItemId, table.contentHash),
    index('source_item_versions_item_fetched_idx').on(
      table.sourceItemId,
      table.fetchedAt.desc(),
    ),
  ],
);

/** What a model understood a version to say, with the spans supporting each part. */
export const contentExtractions = pgTable(
  'content_extractions',
  {
    id: uuid('id').primaryKey(),
    sourceItemVersionId: uuid('source_item_version_id')
      .notNull()
      .references(() => sourceItemVersions.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),

    contentType: text('content_type'),
    title: text('title'),
    oneSentenceSummary: text('one_sentence_summary'),
    extraction: jsonb('extraction').$type<Record<string, unknown>>().notNull().default({}),

    /** Which model, under which prompt (§63R). Makes output drift answerable. */
    model: text('model'),
    modelVersion: text('model_version'),
    promptVersion: text('prompt_version'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /**
     * True when the source was too long and was cut. An extraction of truncated text is
     * not an extraction of that source, and a reader has to be able to tell.
     */
    inputTruncated: boolean('input_truncated').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('content_extractions_version_key').on(table.sourceItemVersionId)],
);

/**
 * How a brand speaks, and what it will not say (§63K).
 *
 * `bannedPhrases` is enforced as a check on generated drafts rather than only as a prompt
 * instruction, because a prompt is a request and a check is a guarantee.
 */
export const brandProfiles = pgTable(
  'brand_profiles',
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

    tone: text('tone'),
    audience: text('audience'),
    bannedPhrases: text('banned_phrases').array().notNull().default(sql`'{}'::text[]`),
    requiredDisclosures: text('required_disclosures').array().notNull().default(sql`'{}'::text[]`),
    styleNotes: text('style_notes'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [uniqueIndex('brand_profiles_profile_key').on(table.profileId)],
);

/** One source, adapted into a set of per-network drafts (§63N). */
export const socialDraftSets = pgTable(
  'social_draft_sets',
  {
    id: uuid('id').primaryKey(),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    contentExtractionId: uuid('content_extraction_id').references(() => contentExtractions.id, {
      onDelete: 'set null',
    }),

    /** Starts as `draft`. P20: a set that arrived approved would make that a comment. */
    status: text('status').$type<DraftSetStatus>().notNull().default('draft'),
    /**
     * Set when a generated claim could not be traced to a source span (P18). A set with
     * this true is never eligible for automatic publishing, whatever the automation mode
     * says.
     */
    groundingFailed: boolean('grounding_failed').notNull().default(false),
    title: text('title'),
    ...timestamps,
  },
  (table) => [
    index('social_draft_sets_environment_idx').on(
      table.projectEnvironmentId,
      table.createdAt.desc(),
    ),
  ],
);

/** What one network would publish. Becomes a post only when somebody publishes it. */
export const socialDrafts = pgTable(
  'social_drafts',
  {
    id: uuid('id').primaryKey(),
    draftSetId: uuid('draft_set_id')
      .notNull()
      .references(() => socialDraftSets.id, { onDelete: 'cascade' }),
    destinationId: uuid('destination_id').references(() => socialDestinations.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),

    body: text('body').notNull(),
    mediaIds: uuid('media_ids').array().notNull().default(sql`'{}'::uuid[]`),
    /** The post created from this draft, once somebody published it. */
    postId: uuid('post_id').references(() => posts.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (table) => [index('social_drafts_set_idx').on(table.draftSetId)],
);

/**
 * Every factual claim in a draft, and the spans that support it.
 *
 * This table is what makes "prove this sentence came from the source" a query rather than
 * a judgement call.
 */
export const draftGroundingClaims = pgTable(
  'draft_grounding_claims',
  {
    id: uuid('id').primaryKey(),
    socialDraftId: uuid('social_draft_id')
      .notNull()
      .references(() => socialDrafts.id, { onDelete: 'cascade' }),
    claimText: text('claim_text').notNull(),
    claimKind: text('claim_kind').notNull().default('fact'),
    sourceSpanIds: text('source_span_ids').array().notNull().default(sql`'{}'::text[]`),
    verified: boolean('verified').notNull().default(false),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('draft_grounding_claims_draft_idx').on(table.socialDraftId),
    index('draft_grounding_claims_unverified_idx')
      .on(table.socialDraftId)
      .where(sql`verified = false`),
  ],
);

/**
 * Immutable record of every model call (§63R).
 *
 * Without it, "why did the output change last Tuesday" is unanswerable, and so is the bill.
 */
export const llmRuns = pgTable(
  'llm_runs',
  {
    id: uuid('id').primaryKey(),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    modelVersion: text('model_version'),
    promptVersion: text('prompt_version'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms'),
    outcome: text('outcome').notNull(),
    errorCode: text('error_code'),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('llm_runs_environment_created_idx').on(
      table.projectEnvironmentId,
      table.createdAt.desc(),
    ),
    index('llm_runs_resource_idx').on(table.resourceType, table.resourceId),
  ],
);

export const contentSourcesRelations = relations(contentSources, ({ many }) => ({
  items: many(sourceItems),
}));

export const sourceItemsRelations = relations(sourceItems, ({ one, many }) => ({
  source: one(contentSources, {
    fields: [sourceItems.contentSourceId],
    references: [contentSources.id],
  }),
  versions: many(sourceItemVersions),
}));

export const sourceItemVersionsRelations = relations(sourceItemVersions, ({ one }) => ({
  item: one(sourceItems, {
    fields: [sourceItemVersions.sourceItemId],
    references: [sourceItems.id],
  }),
  extraction: one(contentExtractions),
}));

export const socialDraftSetsRelations = relations(socialDraftSets, ({ one, many }) => ({
  extraction: one(contentExtractions, {
    fields: [socialDraftSets.contentExtractionId],
    references: [contentExtractions.id],
  }),
  drafts: many(socialDrafts),
}));

export const socialDraftsRelations = relations(socialDrafts, ({ one, many }) => ({
  set: one(socialDraftSets, {
    fields: [socialDrafts.draftSetId],
    references: [socialDraftSets.id],
  }),
  claims: many(draftGroundingClaims),
}));

export type ContentSource = typeof contentSources.$inferSelect;
export type SourceItem = typeof sourceItems.$inferSelect;
export type SourceItemVersion = typeof sourceItemVersions.$inferSelect;
export type ContentExtraction = typeof contentExtractions.$inferSelect;
export type BrandProfile = typeof brandProfiles.$inferSelect;
export type SocialDraftSet = typeof socialDraftSets.$inferSelect;
export type SocialDraft = typeof socialDrafts.$inferSelect;
export type DraftGroundingClaim = typeof draftGroundingClaims.$inferSelect;
export type LlmRun = typeof llmRuns.$inferSelect;
