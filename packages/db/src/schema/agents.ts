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

import { organizations, profiles, projectEnvironments, projects } from './tenancy.js';

/**
 * Agent governance and the approval control plane (plan §51, Phase 9).
 *
 * The premise: an agent acting on a customer's social accounts is not a script with a key,
 * it is an actor whose authority has to be describable, auditable and revocable
 * independently of the credential it happens to hold.
 *
 * The default is review, not autonomy (plan P20). An organization that has configured
 * nothing gets an agent that can draft and cannot publish — because the failure mode of
 * the opposite default is a stranger's brand posting something nobody approved, and no
 * amount of after-the-fact tooling makes that recoverable.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * A named non-human actor.
 *
 * Separate from the API key it authenticates with, because the two have different
 * lifetimes and different questions attached. A key is rotated; an identity persists so
 * that "what has this agent done over six months" survives the rotation, and so revoking
 * an agent's authority does not require finding every key it ever used.
 */
export const agentIdentities = pgTable(
  'agent_identities',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),
    /** Who operates it — a vendor name, an internal team. Shown in the audit trail. */
    operator: text('operator'),

    /** Revoked rather than deleted, so its history stays attributable. */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),

    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index('agent_identities_org_idx').on(table.organizationId),
    uniqueIndex('agent_identities_org_name_key').on(table.organizationId, table.name),
  ],
);

/**
 * One rule about what an agent may do (plan Phase 9).
 *
 * Rules are data, not code, because the interesting ones are specific to a customer:
 * "Instagram Reels require approval", "any political content requires approval", "may
 * auto-publish to LinkedIn". Encoding those as branches would mean a deploy per customer.
 */
export const agentPolicies = pgTable(
  'agent_policies',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id').references(() => projectEnvironments.id, {
      onDelete: 'cascade',
    }),
    /** Null applies to every agent in scope. */
    agentIdentityId: uuid('agent_identity_id').references(() => agentIdentities.id, {
      onDelete: 'cascade',
    }),

    name: text('name').notNull(),
    /**
     * Higher wins. Ties are broken toward the more restrictive effect, so a
     * misconfiguration that leaves two rules at the same priority fails safe rather than
     * quietly granting the broader one.
     */
    priority: integer('priority').notNull().default(0),

    /** `allow`, `require_approval`, `deny`. */
    effect: text('effect').notNull(),

    /** Actions this rule covers: `posts:create`, `posts:delete`, `inbox:reply`, or `*`. */
    actions: text('actions').array().notNull().default(sql`'{}'::text[]`),
    /** Providers it covers. Empty means all of them. */
    providers: text('providers').array().notNull().default(sql`'{}'::text[]`),

    /**
     * Extra conditions evaluated against the action's own attributes — post type,
     * detected topics, whether media is present. Kept as JSON because the vocabulary grows
     * with the product and a column per condition would be a migration per idea.
     */
    conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull().default({}),

    /** Which role can approve when this rule requires it. */
    requiredApproverRole: text('required_approver_role').notNull().default('admin'),
    /** Stable machine code explaining the decision, e.g. `SENSITIVE_TOPIC`. */
    reasonCode: text('reason_code'),

    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('agent_policies_org_priority_idx').on(table.organizationId, table.priority.desc()),
    index('agent_policies_agent_idx').on(table.agentIdentityId),
  ],
);

/**
 * One unit of agent work — a session, a job, a conversation turn.
 *
 * Actions hang off a run so "the agent posted seventeen things last night" is one
 * investigable event rather than seventeen unrelated ones.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey(),
    agentIdentityId: uuid('agent_identity_id')
      .notNull()
      .references(() => agentIdentities.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'set null' }),

    /** `running`, `completed`, `failed`, `abandoned`. */
    status: text('status').notNull().default('running'),
    /** What the agent was asked to do, in the requester's own words. */
    objective: text('objective'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    traceId: text('trace_id'),
    ...timestamps,
  },
  (table) => [
    index('agent_runs_identity_started_idx').on(table.agentIdentityId, table.startedAt.desc()),
    index('agent_runs_environment_idx').on(table.projectEnvironmentId),
  ],
);

/**
 * One thing an agent tried to do, and what the policy engine said about it.
 *
 * Append-only, and written whether the action was allowed, held or refused. Recording only
 * the permitted ones would leave no evidence of an agent repeatedly attempting something
 * it should not — which is precisely the signal worth having.
 */
export const agentActions = pgTable(
  'agent_actions',
  {
    id: uuid('id').primaryKey(),
    agentRunId: uuid('agent_run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    agentIdentityId: uuid('agent_identity_id')
      .notNull()
      .references(() => agentIdentities.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),

    action: text('action').notNull(),
    provider: text('provider'),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),

    /** `allowed`, `requires_approval`, `denied`. */
    decision: text('decision').notNull(),
    /** Which rule decided it. Null when the default applied (plan P20). */
    policyId: uuid('policy_id').references(() => agentPolicies.id, { onDelete: 'set null' }),
    reasonCode: text('reason_code'),
    /** The attributes the decision was made against, frozen for audit. */
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),

    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_actions_identity_created_idx').on(table.agentIdentityId, table.createdAt.desc()),
    index('agent_actions_resource_idx').on(table.resourceType, table.resourceId),
    /** Drives "what has been refused lately", the query an operator actually runs. */
    index('agent_actions_decision_idx')
      .on(table.organizationId, table.createdAt.desc())
      .where(sql`${table.decision} <> 'allowed'`),
  ],
);

/**
 * Something waiting for a human (plan Phase 9).
 *
 * Expiry is mandatory and not nullable. A request that waits forever is a post that
 * silently never goes out, which is the worst failure this product has — so an unanswered
 * request expires visibly rather than sitting in a queue nobody reads.
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectEnvironmentId: uuid('project_environment_id')
      .notNull()
      .references(() => projectEnvironments.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'set null' }),

    agentIdentityId: uuid('agent_identity_id').references(() => agentIdentities.id, {
      onDelete: 'set null',
    }),
    agentActionId: uuid('agent_action_id').references(() => agentActions.id, {
      onDelete: 'set null',
    }),

    /** What is being approved. `post` today; `reply` and `campaign` later. */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),

    /** `pending`, `approved`, `rejected`, `expired`, `cancelled`. */
    status: text('status').notNull().default('pending'),
    reasonCode: text('reason_code'),
    requiredApproverRole: text('required_approver_role').notNull().default('admin'),

    /** A human-readable précis so an approver does not have to open the resource. */
    summary: text('summary'),

    decidedByUserId: uuid('decided_by_user_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    traceId: text('trace_id'),
    ...timestamps,
  },
  (table) => [
    index('approval_requests_pending_idx')
      .on(table.projectEnvironmentId, table.createdAt.desc())
      .where(sql`${table.status} = 'pending'`),
    /** Drives the expiry sweep. */
    index('approval_requests_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
    /**
     * One live request per subject. Two pending approvals for the same post would let one
     * approver accept while another rejects, and nothing decides which wins.
     */
    uniqueIndex('approval_requests_subject_key')
      .on(table.subjectType, table.subjectId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export const agentIdentitiesRelations = relations(agentIdentities, ({ many }) => ({
  policies: many(agentPolicies),
  runs: many(agentRuns),
  actions: many(agentActions),
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  identity: one(agentIdentities, {
    fields: [agentRuns.agentIdentityId],
    references: [agentIdentities.id],
  }),
  actions: many(agentActions),
}));

export type AgentIdentity = typeof agentIdentities.$inferSelect;
export type AgentPolicy = typeof agentPolicies.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentAction = typeof agentActions.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
