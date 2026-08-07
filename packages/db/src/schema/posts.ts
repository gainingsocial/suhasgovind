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

import { socialConnections, socialDestinations } from './connections.js';
import {
  approvalStatusEnum,
  attemptOutcomeEnum,
  postStatusEnum,
  postTargetStatusEnum,
} from './enums.js';
import { organizations, profiles, projectEnvironments, projects } from './tenancy.js';

/**
 * The publishing core (plan §11, §12, §24, §25).
 *
 * One logical post fans out into N independently stateful targets (plan P2). The post's
 * status is DERIVED from its targets by one tested reducer (plan §78) and is never set
 * directly from timestamps.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** The customer's intended cross-platform publication. */
export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    status: postStatusEnum('status').notNull().default('draft'),

    /**
     * Canonical content, before per-target overrides and provider options are applied
     * (plan §11.2). Stored as written so a post can be re-resolved if an adapter's
     * default resolver changes.
     */
    content: jsonb('content')
      .$type<{
        text?: string;
        media_ids?: string[];
        link?: string;
        [key: string]: unknown;
      }>()
      .notNull(),

    /** NULL means publish immediately. */
    publishAt: timestamp('publish_at', { withTimezone: true }),
    timezone: text('timezone'),

    requiresApproval: boolean('requires_approval').notNull().default(false),
    /** Skips the content-fingerprint check in ADR-006 Layer 3. */
    allowDuplicate: boolean('allow_duplicate').notNull().default(false),

    /** Cloudflare Workflow instance driving this post's lifecycle (plan §27). */
    workflowInstanceId: text('workflow_instance_id'),

    idempotencyKeyId: uuid('idempotency_key_id'),
    createdByApiKeyId: uuid('created_by_api_key_id'),
    createdByUserId: uuid('created_by_user_id'),

    requestId: text('request_id'),
    traceId: text('trace_id'),

    /** Set once every target reaches a terminal state. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    // Plan §91 index plan.
    index('posts_profile_created_idx').on(table.profileId, table.createdAt.desc()),
    index('posts_environment_status_publish_idx').on(
      table.projectEnvironmentId,
      table.status,
      table.publishAt,
    ),
    /**
     * Drives the Cron reconciler (plan §27): scheduled posts whose time has passed and
     * which have no live workflow. Partial so the index stays tiny — it only ever
     * contains work that is genuinely pending.
     */
    index('posts_due_reconciliation_idx')
      .on(table.publishAt)
      .where(sql`${table.status} IN ('scheduled', 'queued')`),
    index('posts_trace_idx').on(table.traceId),
  ],
);

/**
 * One destination's independent publishing state (plan P2).
 *
 * The `lease_id` / `lease_expires_at` pair is ADR-006 Layer 2: a queue message never
 * grants the right to publish, winning the conditional UPDATE does. That is what makes
 * at-least-once queue delivery safe.
 */
export const postTargets = pgTable(
  'post_targets',
  {
    id: uuid('id').primaryKey(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => socialDestinations.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => socialConnections.id, { onDelete: 'restrict' }),
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

    status: postTargetStatusEnum('status').notNull().default('pending'),

    /** Per-target content override (plan §11.2 step 2). */
    overrides: jsonb('overrides').$type<Record<string, unknown>>(),
    /** Typed provider-native options (plan §11.3, ADR-008). */
    options: jsonb('options').$type<Record<string, unknown>>(),
    /** The fully resolved payload actually sent, captured for the timeline and for replay. */
    resolvedContent: jsonb('resolved_content').$type<Record<string, unknown>>(),

    // ---- execution lease (ADR-006 Layer 2) ----
    leaseId: uuid('lease_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),

    // ---- outcome ----
    providerPostId: text('provider_post_id'),
    providerPostUrl: text('provider_post_url'),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    /** Normalized taxonomy code (plan §79), never a raw provider string. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    providerErrorSubcode: text('provider_error_subcode'),
    retryable: boolean('retryable'),

    /**
     * ADR-006 Layer 3. `sha256(provider + destination + normalized content + media
     * identity + time bucket)`. Advisory: a duplicate is blocked at create time, not by
     * a database constraint, because customers legitimately repost.
     */
    contentFingerprint: text('content_fingerprint'),

    /** Set when the outcome is genuinely unknown and reconciliation must run first. */
    reconciliationRequiredAt: timestamp('reconciliation_required_at', { withTimezone: true }),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),

    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('post_targets_post_idx').on(table.postId),
    index('post_targets_destination_created_idx').on(table.destinationId, table.createdAt.desc()),
    /** Drives the retry sweeper. Partial so it only contains work awaiting execution. */
    index('post_targets_status_next_attempt_idx')
      .on(table.status, table.nextAttemptAt)
      .where(sql`${table.status} IN ('queued', 'retryable_failed', 'scheduled')`),
    /** Finds abandoned leases whose worker died mid-publish. */
    index('post_targets_lease_expiry_idx')
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} = 'publishing'`),
    /** One target per destination per post — a duplicated destination is a client bug. */
    uniqueIndex('post_targets_post_destination_key').on(table.postId, table.destinationId),
    index('post_targets_fingerprint_idx')
      .on(table.destinationId, table.contentFingerprint)
      .where(sql`${table.contentFingerprint} IS NOT NULL`),
  ],
);

/**
 * Immutable record of one provider call (plan §85 Rule 6, §40).
 *
 * Append-only. This is the evidence trail behind `GET /v1/posts/{id}/timeline` and the
 * only way to answer "did we actually call TikTok, and what did it say?".
 */
export const postTargetAttempts = pgTable(
  'post_target_attempts',
  {
    id: uuid('id').primaryKey(),
    postTargetId: uuid('post_target_id')
      .notNull()
      .references(() => postTargets.id, { onDelete: 'cascade' }),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),

    outcome: attemptOutcomeEnum('outcome'),
    providerPostId: text('provider_post_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    providerErrorSubcode: text('provider_error_subcode'),
    providerStatus: integer('provider_status'),

    /** Which lease authorized this attempt. Ties an attempt to the worker that ran it. */
    leaseId: uuid('lease_id'),
    /** Sanitized (plan §7.2) — never raw request/response bodies. */
    requestSummary: jsonb('request_summary').$type<Record<string, unknown>>(),
    responseSummary: jsonb('response_summary').$type<Record<string, unknown>>(),

    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Plan §10.6 — a unique attempt sequence per target.
    uniqueIndex('post_target_attempts_target_number_key').on(table.postTargetId, table.attemptNumber),
    index('post_target_attempts_post_idx').on(table.postId),
    index('post_target_attempts_trace_idx').on(table.traceId),
  ],
);

/**
 * Approval workflow (plan §2.2, §24.2).
 *
 * Present in the domain model from Phase 1 even though the governance UI arrives later,
 * because retrofitting approval into a publishing state machine that never had it is
 * exactly the kind of rewrite plan P14 forbids.
 */
export const postApprovals = pgTable(
  'post_approvals',
  {
    id: uuid('id').primaryKey(),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    status: approvalStatusEnum('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    note: text('note'),
    ...timestamps,
  },
  (table) => [
    index('post_approvals_post_idx').on(table.postId),
    index('post_approvals_pending_idx')
      .on(table.projectEnvironmentId, table.requestedAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);

// ---------------------------------------------------------------------------

export const postsRelations = relations(posts, ({ one, many }) => ({
  profile: one(profiles, { fields: [posts.profileId], references: [profiles.id] }),
  targets: many(postTargets),
  approvals: many(postApprovals),
}));

export const postTargetsRelations = relations(postTargets, ({ one, many }) => ({
  post: one(posts, { fields: [postTargets.postId], references: [posts.id] }),
  destination: one(socialDestinations, {
    fields: [postTargets.destinationId],
    references: [socialDestinations.id],
  }),
  connection: one(socialConnections, {
    fields: [postTargets.connectionId],
    references: [socialConnections.id],
  }),
  attempts: many(postTargetAttempts),
}));

export const postTargetAttemptsRelations = relations(postTargetAttempts, ({ one }) => ({
  target: one(postTargets, {
    fields: [postTargetAttempts.postTargetId],
    references: [postTargets.id],
  }),
}));

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type PostTarget = typeof postTargets.$inferSelect;
export type NewPostTarget = typeof postTargets.$inferInsert;
export type PostTargetAttempt = typeof postTargetAttempts.$inferSelect;
export type PostApproval = typeof postApprovals.$inferSelect;
