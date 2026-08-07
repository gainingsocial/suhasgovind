import { sql } from 'drizzle-orm';
import {
  bigint,
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

import { actorTypeEnum } from './enums.js';
import { organizations, profiles, projectEnvironments, projects } from './tenancy.js';

/**
 * Observability, audit and usage (plan §40, §70, §92).
 *
 * Everything here is append-only. Immutable events are what make usage billable, audits
 * defensible and incidents reconstructable (plan §85 Rule 11).
 */

/** Inbound provider webhook events, deduplicated (plan §10.4, §34). */
export const providerEvents = pgTable(
  'provider_events',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    /**
     * The provider's own event ID when it supplies a stable one. UNIQUE with `provider`,
     * so a redelivered webhook is a no-op insert rather than duplicated processing.
     */
    providerEventId: text('provider_event_id'),
    /**
     * Fallback when the provider supplies no ID: a hash of the raw body plus a short
     * dedupe window (plan §10.4).
     */
    fingerprint: text('fingerprint'),
    eventType: text('event_type'),

    /** Resolved after ingestion — the webhook arrives before we know whose it is. */
    connectionId: uuid('connection_id'),
    projectEnvironmentId: uuid('project_environment_id').references(() => projectEnvironments.id, {
      onDelete: 'cascade',
    }),

    /** False means the signature check failed — stored for forensics, never processed. */
    signatureVerified: boolean('signature_verified').notNull().default(false),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingError: text('processing_error'),
    traceId: text('trace_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('provider_events_provider_event_id_key')
      .on(table.provider, table.providerEventId)
      .where(sql`${table.providerEventId} IS NOT NULL`),
    uniqueIndex('provider_events_fingerprint_key')
      .on(table.provider, table.fingerprint)
      .where(sql`${table.fingerprint} IS NOT NULL`),
    index('provider_events_unprocessed_idx')
      .on(table.receivedAt)
      .where(sql`${table.processedAt} IS NULL`),
  ],
);

/**
 * Sanitized provider call log (plan §40).
 *
 * Distinct from `post_target_attempts`: attempts are the publishing story, this is every
 * provider call including auth, destination discovery and health checks.
 */
export const providerRequestLogs = pgTable(
  'provider_request_logs',
  {
    id: uuid('id').primaryKey(),
    projectEnvironmentId: uuid('project_environment_id').references(() => projectEnvironments.id, {
      onDelete: 'cascade',
    }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    provider: text('provider').notNull(),
    connectionId: uuid('connection_id'),
    destinationId: uuid('destination_id'),

    operation: text('operation').notNull(),
    method: text('method').notNull(),
    /** Query string redacted before persistence (plan §7.2). */
    url: text('url').notNull(),
    status: integer('status'),
    durationMs: integer('duration_ms'),
    outcome: text('outcome').notNull(),
    normalizedErrorCode: text('normalized_error_code'),

    requestSummary: jsonb('request_summary').$type<Record<string, unknown>>(),
    responseSummary: jsonb('response_summary').$type<Record<string, unknown>>(),
    rateLimit: jsonb('rate_limit').$type<Record<string, unknown>>(),

    requestId: text('request_id'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('provider_request_logs_trace_idx').on(table.traceId),
    index('provider_request_logs_environment_created_idx').on(
      table.projectEnvironmentId,
      table.createdAt.desc(),
    ),
    index('provider_request_logs_connection_idx').on(table.connectionId),
  ],
);

/** Inbound API request log — the source for `GET /v1/requests/{request_id}` (plan §40). */
export const apiRequestLogs = pgTable(
  'api_request_logs',
  {
    id: uuid('id').primaryKey(),
    requestId: text('request_id').notNull(),
    traceId: text('trace_id').notNull(),
    projectEnvironmentId: uuid('project_environment_id').references(() => projectEnvironments.id, {
      onDelete: 'cascade',
    }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    apiKeyId: uuid('api_key_id'),

    method: text('method').notNull(),
    path: text('path').notNull(),
    routePattern: text('route_pattern'),
    status: integer('status').notNull(),
    durationMs: integer('duration_ms').notNull(),

    errorCode: text('error_code'),
    idempotencyKey: text('idempotency_key'),
    /** Truncated and redacted. Enough to debug, not enough to be a data store. */
    requestSummary: jsonb('request_summary').$type<Record<string, unknown>>(),
    responseSummary: jsonb('response_summary').$type<Record<string, unknown>>(),

    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('api_request_logs_request_id_key').on(table.requestId),
    index('api_request_logs_environment_created_idx').on(
      table.projectEnvironmentId,
      table.createdAt.desc(),
    ),
    index('api_request_logs_trace_idx').on(table.traceId),
  ],
);

/** Immutable audit trail (plan §92). Who did what, to which resource, from where. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id').references(() => projectEnvironments.id, {
      onDelete: 'cascade',
    }),

    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    /** Redacted to a key prefix — never the raw key (ADR-007). */
    actorLabel: text('actor_label'),

    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),

    /** Before/after for mutations, already redacted. */
    changes: jsonb('changes').$type<Record<string, unknown>>(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),

    requestId: text('request_id'),
    traceId: text('trace_id'),
    ipHash: text('ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_events_org_created_idx').on(table.organizationId, table.createdAt.desc()),
    index('audit_events_resource_idx').on(table.resourceType, table.resourceId),
    index('audit_events_actor_idx').on(table.actorType, table.actorId),
  ],
);

/**
 * Usage events (plan §70).
 *
 * Immutable and recorded at the moment of the billable action, so billing is reconstructable
 * from first principles rather than trusted from a counter that may have drifted.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'set null' }),

    /** `post_published`, `api_request`, `media_processed`, `connection_active`, … */
    metric: text('metric').notNull(),
    quantity: integer('quantity').notNull().default(1),
    provider: text('provider'),

    /** Ties a usage row to the thing that caused it, so disputes are resolvable. */
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),

    /** UTC date bucket, `YYYY-MM-DD`, for cheap period aggregation. */
    usageDate: text('usage_date').notNull(),
    traceId: text('trace_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('usage_events_org_date_metric_idx').on(table.organizationId, table.usageDate, table.metric),
    index('usage_events_environment_date_idx').on(table.projectEnvironmentId, table.usageDate),
    /**
     * Makes usage recording itself idempotent: a queue redelivery that re-records
     * "post published" for the same target cannot double-bill.
     */
    uniqueIndex('usage_events_resource_metric_key')
      .on(table.metric, table.resourceType, table.resourceId)
      .where(sql`${table.resourceId} IS NOT NULL`),
  ],
);

/** Rolled-up counters for fast quota checks on the request path (plan §70). */
export const usageCounters = pgTable(
  'usage_counters',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id').references(() => projectEnvironments.id, {
      onDelete: 'cascade',
    }),
    metric: text('metric').notNull(),
    /** `YYYY-MM-DD` for daily, `YYYY-MM` for monthly. */
    period: text('period').notNull(),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('usage_counters_scope_key').on(
      table.organizationId,
      table.projectEnvironmentId,
      table.metric,
      table.period,
    ),
  ],
);

export type ProviderEvent = typeof providerEvents.$inferSelect;
export type ProviderRequestLog = typeof providerRequestLogs.$inferSelect;
export type ApiRequestLog = typeof apiRequestLogs.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type UsageCounter = typeof usageCounters.$inferSelect;
