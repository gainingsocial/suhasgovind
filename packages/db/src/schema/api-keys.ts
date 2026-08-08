import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { apiKeyStatusEnum } from './enums.js';
import { organizations, profiles, projectEnvironments, projects } from './tenancy.js';

/**
 * API keys (plan §38).
 *
 * The raw key is shown once at creation and never stored. `key_hash` is a peppered
 * HMAC-SHA256 (ADR-007), and it is UNIQUE so authentication is a single indexed equality
 * lookup — never a scan comparing candidate hashes, which would reintroduce a timing side
 * channel at the database layer.
 */
export const apiKeys = pgTable(
  'api_keys',
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

    name: text('name').notNull(),
    /** `sk_live_a1B2c3D4` — for dashboard identification only; not secret. */
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),

    status: apiKeyStatusEnum('status').notNull().default('active'),

    /**
     * Optional profile restriction (plan §38 "later allow profile-specific keys").
     * Empty means the key may act on any profile in its environment.
     */
    restrictedToProfileId: uuid('restricted_to_profile_id').references(() => profiles.id, {
      onDelete: 'cascade',
    }),

    createdByUserId: uuid('created_by_user_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Updated opportunistically — never on the synchronous auth path (plan §90). */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id'),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('api_keys_hash_key').on(table.keyHash),
    index('api_keys_environment_idx').on(table.projectEnvironmentId),
    index('api_keys_prefix_idx').on(table.keyPrefix),
  ],
);

/**
 * Scopes as rows rather than an array column, so revoking one scope across many keys is a
 * single statement and so scope grants are individually auditable.
 */
export const apiKeyScopes = pgTable(
  'api_key_scopes',
  {
    id: uuid('id').primaryKey(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('api_key_scopes_key_scope_key').on(table.apiKeyId, table.scope),
    index('api_key_scopes_key_idx').on(table.apiKeyId),
  ],
);

export const apiKeysRelations = relations(apiKeys, ({ many, one }) => ({
  scopes: many(apiKeyScopes),
  environment: one(projectEnvironments, {
    fields: [apiKeys.projectEnvironmentId],
    references: [projectEnvironments.id],
  }),
}));

export const apiKeyScopesRelations = relations(apiKeyScopes, ({ one }) => ({
  apiKey: one(apiKeys, { fields: [apiKeyScopes.apiKeyId], references: [apiKeys.id] }),
}));

/**
 * Every scope the API recognizes (plan §38). Defined in `@gs/contracts` and re-exported
 * here: `@gs/auth` enforces them and must not depend on the database package.
 */
export { API_SCOPES, type ApiScope } from '@gs/contracts/scopes';

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type ApiKeyScope = typeof apiKeyScopes.$inferSelect;
