import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { organizations, projectEnvironments, projects } from './tenancy.js';

/**
 * Platform capability registry, provider versions and feature flags
 * (plan §17, §44, §45, §80, §94).
 *
 * Generic capability is code that lives in each adapter; this table is its published,
 * versioned snapshot, so the API can answer capability questions without invoking every
 * adapter, and so a client can detect staleness via `effective_at`.
 */
export const platformCapabilities = pgTable(
  'platform_capabilities',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    schemaVersion: text('schema_version').notNull().default('1'),
    adapterVersion: text('adapter_version').notNull(),
    /** The full capability document (plan §17). */
    features: jsonb('features').$type<Record<string, unknown>>().notNull(),
    /** When this snapshot became current. Clients cache against it. */
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('platform_capabilities_provider_idx').on(table.provider),
    /** Exactly one current snapshot per provider. */
    uniqueIndex('platform_capabilities_current_key')
      .on(table.provider)
      .where(sql`${table.supersededAt} IS NULL`),
  ],
);

/**
 * Which provider API version each adapter targets (plan §44).
 *
 * Providers deprecate versions on their own schedule; recording ours explicitly means a
 * deprecation notice becomes a tracked item rather than a surprise outage.
 */
export const providerVersions = pgTable(
  'provider_versions',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    apiVersion: text('api_version').notNull(),
    adapterVersion: text('adapter_version').notNull(),
    status: text('status').notNull().default('active'),
    deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
    sunsetAt: timestamp('sunset_at', { withTimezone: true }),
    notes: text('notes'),
    docsUrl: text('docs_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('provider_versions_provider_api_key').on(table.provider, table.apiVersion)],
);

/**
 * Feature flags (plan §45, §85 Rule 12).
 *
 * Scope precedence, most specific wins: environment → project → organization → global.
 * Incomplete provider features ship behind a flag rather than behind a branch.
 */
export const featureFlags = pgTable(
  'feature_flags',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    description: text('description'),

    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id').references(() => projectEnvironments.id, {
      onDelete: 'cascade',
    }),

    enabled: boolean('enabled').notNull().default(false),
    /** 0–100 for gradual rollout of a risky adapter change. */
    rolloutPercentage: real('rollout_percentage'),
    /** Free-form configuration the flag carries, e.g. a per-provider limit override. */
    value: jsonb('value').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('feature_flags_key_idx').on(table.key),
    uniqueIndex('feature_flags_scope_key').on(
      table.key,
      table.organizationId,
      table.projectId,
      table.projectEnvironmentId,
    ),
  ],
);

/**
 * Provider compliance registry (plan §94, §95).
 *
 * Platform rules that are data, not code: required declarations, disclosure text,
 * attribution requirements, prohibited content categories. Kept in the database so a
 * platform policy change is a data update, not a deploy.
 */
export const providerComplianceRules = pgTable(
  'provider_compliance_rules',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    ruleKey: text('rule_key').notNull(),
    ruleType: text('rule_type').notNull(),
    /** Which post types / destination types this applies to. */
    appliesTo: jsonb('applies_to').$type<Record<string, unknown>>().notNull().default({}),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    /** `blocking` fails preflight; `warning` surfaces but permits publishing. */
    severity: text('severity').notNull().default('blocking'),
    docsUrl: text('docs_url'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('provider_compliance_rules_provider_key_key').on(table.provider, table.ruleKey),
    index('provider_compliance_rules_active_idx')
      .on(table.provider)
      .where(sql`${table.retiredAt} IS NULL`),
  ],
);

/** Provider incident/health tracking behind `GET /v1/provider-health` (plan §41). */
export const providerHealthStatus = pgTable(
  'provider_health_status',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    status: text('status').notNull().default('operational'),
    /** Rolling error rate the publisher maintains, used to open a circuit breaker. */
    errorRate: real('error_rate'),
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull().defaultNow(),
    lastIncidentAt: timestamp('last_incident_at', { withTimezone: true }),
    detail: text('detail'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('provider_health_status_provider_key').on(table.provider)],
);

export type PlatformCapability = typeof platformCapabilities.$inferSelect;
export type ProviderVersion = typeof providerVersions.$inferSelect;
export type FeatureFlag = typeof featureFlags.$inferSelect;
export type ProviderComplianceRule = typeof providerComplianceRules.$inferSelect;
export type ProviderHealthStatus = typeof providerHealthStatus.$inferSelect;
