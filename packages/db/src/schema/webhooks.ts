import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { webhookDeliveryStatusEnum, webhookEndpointStatusEnum } from './enums.js';
import { organizations, profiles, projectEnvironments, projects } from './tenancy.js';

/**
 * Customer webhooks as first-class infrastructure (plan P8, §35, §36).
 *
 * Deliveries are at-least-once. Every event carries a stable `event_id` across all of its
 * delivery attempts, which is what makes a customer's own deduplication possible.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey(),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    url: text('url').notNull(),
    description: text('description'),
    status: webhookEndpointStatusEnum('status').notNull().default('enabled'),

    /**
     * The signing secret is DERIVED from a root in Secrets Store, not stored (ADR-007).
     * Only the version lives here; bumping it rotates the secret and the previous version
     * stays derivable during the overlap window.
     */
    secretVersion: integer('secret_version').notNull().default(1),
    secretRotatedAt: timestamp('secret_rotated_at', { withTimezone: true }),

    /** Optional narrowing so an agency endpoint only hears about one brand. */
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }),

    /** Consecutive failures. Drives auto-disable so a dead endpoint stops burning retries. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    autoDisabledAt: timestamp('auto_disabled_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),

    /** Pinned so a payload-shape change cannot silently break an existing integration. */
    apiVersion: text('api_version').notNull(),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index('webhook_endpoints_environment_idx').on(table.projectEnvironmentId),
    index('webhook_endpoints_enabled_idx')
      .on(table.projectEnvironmentId)
      .where(sql`${table.status} = 'enabled'`),
  ],
);

/** Which event types an endpoint wants. No subscriptions means all of them. */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey(),
    webhookEndpointId: uuid('webhook_endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('webhook_subscriptions_endpoint_type_key').on(table.webhookEndpointId, table.eventType),
  ],
);

/**
 * The immutable event record (plan §10.5 — one stable internal UUID per event).
 *
 * Separated from `webhook_deliveries` because one event fans out to every subscribed
 * endpoint, and each of those has its own independent retry state.
 */
export const outboundWebhookEvents = pgTable(
  'outbound_webhook_events',
  {
    id: uuid('id').primaryKey(),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }),

    eventType: text('event_type').notNull(),
    apiVersion: text('api_version').notNull(),
    /** The exact JSON body that gets signed and sent. Frozen at creation. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    /** The domain event and aggregate this came from, for the timeline. */
    aggregateType: text('aggregate_type'),
    aggregateId: uuid('aggregate_id'),
    traceId: text('trace_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('outbound_webhook_events_environment_created_idx').on(
      table.projectEnvironmentId,
      table.createdAt.desc(),
    ),
    index('outbound_webhook_events_aggregate_idx').on(table.aggregateType, table.aggregateId),
    index('outbound_webhook_events_trace_idx').on(table.traceId),
  ],
);

/** One event's delivery to one endpoint, with its own retry state (plan §36). */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => outboundWebhookEvents.id, { onDelete: 'cascade' }),
    webhookEndpointId: uuid('webhook_endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),

    status: webhookDeliveryStatusEnum('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),

    /** Same lease mechanism as publish targets — redelivery must not double-send. */
    leaseId: uuid('lease_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    lastStatusCode: integer('last_status_code'),
    lastDurationMs: integer('last_duration_ms'),
    lastError: text('last_error'),
    /** Scrubbed excerpt only — a customer's error page may contain anything. */
    lastResponseExcerpt: text('last_response_excerpt'),

    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    exhaustedAt: timestamp('exhausted_at', { withTimezone: true }),
    /** Set when an operator or customer replays a delivery from the dashboard. */
    replayOfDeliveryId: uuid('replay_of_delivery_id'),

    ...timestamps,
  },
  (table) => [
    // Plan §91 — drives the delivery sweeper.
    index('webhook_deliveries_status_next_attempt_idx')
      .on(table.status, table.nextAttemptAt)
      .where(sql`${table.status} IN ('pending', 'failed_retryable')`),
    index('webhook_deliveries_endpoint_created_idx').on(
      table.webhookEndpointId,
      table.createdAt.desc(),
    ),
    index('webhook_deliveries_event_idx').on(table.eventId),
    /** One delivery per (event, endpoint) — the guard against fan-out duplication. */
    uniqueIndex('webhook_deliveries_event_endpoint_key')
      .on(table.eventId, table.webhookEndpointId)
      .where(sql`${table.replayOfDeliveryId} IS NULL`),
  ],
);

export const webhookEndpointsRelations = relations(webhookEndpoints, ({ many }) => ({
  subscriptions: many(webhookSubscriptions),
  deliveries: many(webhookDeliveries),
}));

export const webhookDeliveriesRelations = relations(webhookDeliveries, ({ one }) => ({
  event: one(outboundWebhookEvents, {
    fields: [webhookDeliveries.eventId],
    references: [outboundWebhookEvents.id],
  }),
  endpoint: one(webhookEndpoints, {
    fields: [webhookDeliveries.webhookEndpointId],
    references: [webhookEndpoints.id],
  }),
}));

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type NewWebhookEndpoint = typeof webhookEndpoints.$inferInsert;
export type OutboundWebhookEvent = typeof outboundWebhookEvents.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
