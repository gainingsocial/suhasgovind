import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { environmentKindEnum, organizationRoleEnum } from './enums.js';

/**
 * The multi-tenant hierarchy (plan §8):
 *
 *   Organization → Project → Environment (test|live) → Profile → Connection → Destination
 *
 * Every downstream table carries `project_environment_id` even where it could be derived
 * by joining upward. That denormalization is deliberate: tenant-ownership checks (plan P5)
 * run on the hot path of every request, and a single indexed equality beats a four-table
 * join. The foreign keys still make an inconsistent row impossible to insert.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** The paying, direct customer: a SaaS company, agency, e-commerce platform or team. */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Set when the org is soft-deleted; retained for the deletion window (plan §108). */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [uniqueIndex('organizations_slug_key').on(table.slug)],
);

/**
 * Human membership. Distinct from API keys: a person is never authenticated by an API key
 * and an API key never inherits a person's role (plan §39).
 */
export const organizationMembers = pgTable(
  'organization_members',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Supabase Auth user ID. Humans authenticate there, not against our API keys. */
    userId: uuid('user_id').notNull(),
    role: organizationRoleEnum('role').notNull().default('viewer'),
    invitedBy: uuid('invited_by'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('organization_members_org_user_key').on(table.organizationId, table.userId),
    index('organization_members_user_idx').on(table.userId),
  ],
);

/** A product or application owned by the organization, e.g. "Acme AI Social App". */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('projects_org_slug_key').on(table.organizationId, table.slug),
    index('projects_org_idx').on(table.organizationId),
  ],
);

/**
 * Test and live environments (plan §8.3).
 *
 * Keys, webhooks, connections and posts are all environment-scoped. A test key must not
 * publish against live connections unless explicitly enabled — that switch lives here
 * rather than in application config so it is auditable per project.
 */
export const projectEnvironments = pgTable(
  'project_environments',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: environmentKindEnum('kind').notNull(),
    /**
     * When true, provider calls are routed to the mock adapter and no social side effect
     * occurs (plan §49). Default true for `test` environments.
     */
    simulationMode: boolean('simulation_mode').notNull().default(false),
    /** Escape hatch for the rare integrator who genuinely wants test keys on live data. */
    allowTestKeyLiveConnections: boolean('allow_test_key_live_connections').notNull().default(false),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('project_environments_project_kind_key').on(table.projectId, table.kind),
    index('project_environments_org_idx').on(table.organizationId),
  ],
);

/**
 * The white-label tenant primitive (plan §8.4): a downstream customer, brand, business,
 * location, creator identity or workspace.
 *
 * This is the object that makes us a SaaS-to-SaaS product rather than a single-tenant
 * scheduler. Everything publishable hangs off a profile.
 */
export const profiles = pgTable(
  'profiles',
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
    /**
     * The customer's own identifier for this profile — their user ID, tenant ID or
     * account number. Unique per environment so an integrator can look a profile up by
     * their key without storing ours.
     */
    externalId: text('external_id'),
    timezone: text('timezone').notNull().default('UTC'),
    /** Arbitrary customer metadata, echoed back on every profile response. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Plan §91 index plan.
    index('profiles_environment_created_idx').on(table.projectEnvironmentId, table.createdAt),
    uniqueIndex('profiles_environment_external_id_key')
      .on(table.projectEnvironmentId, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Relations — used by Drizzle's relational query API for read paths.
// ---------------------------------------------------------------------------

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  projects: many(projects),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  environments: many(projectEnvironments),
}));

export const projectEnvironmentsRelations = relations(projectEnvironments, ({ one, many }) => ({
  project: one(projects, { fields: [projectEnvironments.projectId], references: [projects.id] }),
  profiles: many(profiles),
}));

export const profilesRelations = relations(profiles, ({ one }) => ({
  environment: one(projectEnvironments, {
    fields: [profiles.projectEnvironmentId],
    references: [projectEnvironments.id],
  }),
}));

export type Organization = typeof organizations.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectEnvironment = typeof projectEnvironments.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
