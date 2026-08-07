import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { idempotencyStatusEnum } from './enums.js';
import { organizations, projectEnvironments, projects } from './tenancy.js';

/**
 * Request idempotency (plan §10.2, §77 — ADR-006 Layer 1).
 *
 * The UNIQUE INDEX below is the entire race-prevention mechanism. Reserving a key is an
 * `INSERT ... ON CONFLICT DO NOTHING` inside the create-post transaction, before any
 * downstream work exists. Two simultaneous requests with the same key therefore cannot
 * both proceed — which is precisely the gap Ayrshare documents in its own idempotency
 * implementation (plan §2.2) and which we set out to close.
 *
 * An application-level "check then insert" would NOT be equivalent: the two statements
 * can interleave.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
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

    key: text('key').notNull(),

    /**
     * SHA-256 of the canonicalized request body. Same key + same hash replays the stored
     * result; same key + different hash is `409 IDEMPOTENCY_KEY_REUSED`, because silently
     * returning the first result for a genuinely different request would be worse than
     * an error.
     */
    requestHash: text('request_hash').notNull(),
    /** Guards against one key being reused across different operations. */
    endpoint: text('endpoint').notNull(),

    status: idempotencyStatusEnum('status').notNull().default('in_progress'),

    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    /** The exact response body to replay, so a retry is byte-identical to the original. */
    responseSnapshot: jsonb('response_snapshot').$type<Record<string, unknown>>(),
    responseStatus: text('response_status'),

    apiKeyId: uuid('api_key_id'),
    requestId: text('request_id'),
    traceId: text('trace_id'),

    /**
     * Keys are retained for a bounded window, then swept. Long enough to cover any
     * realistic client retry, short enough that the table does not grow forever.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * Scoped to the environment rather than to the API key (plan §10.2 offers both):
     * a customer rotating keys mid-retry must still get idempotent behaviour, which the
     * key-scoped variant would break.
     */
    uniqueIndex('idempotency_keys_environment_key_key').on(table.projectEnvironmentId, table.key),
    index('idempotency_keys_expiry_idx').on(table.expiresAt),
    index('idempotency_keys_resource_idx').on(table.resourceType, table.resourceId),
  ],
);

export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;
