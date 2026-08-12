import { newUuidV7 } from '@gs/contracts/ids';
import type { AgentPolicyRule, PolicyConditions, PolicyOutcome } from '@gs/domain';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import {
  agentActions,
  agentIdentities,
  agentPolicies,
  agentRuns,
  approvalRequests,
  type AgentIdentity,
  type ApprovalRequest,
} from '../schema/agents.js';

/**
 * Agent governance persistence (plan §51, Phase 9).
 *
 * The decision logic lives in `@gs/domain` and is pure. This module only loads the rules,
 * records what was decided and manages the approvals that follow — which keeps the part
 * with the consequences exhaustively testable without a database.
 */

export interface LoadPoliciesScope {
  organizationId: string;
  projectId?: string | null;
  projectEnvironmentId?: string | null;
  agentIdentityId?: string | null;
}

/**
 * Every policy that could apply, in one query.
 *
 * Scope filtering happens in SQL and rule matching happens in the domain. Splitting it
 * that way means the evaluator never has to know about NULL semantics, and the query never
 * has to know what a condition means.
 */
export async function loadAgentPolicies(
  db: Database,
  scope: LoadPoliciesScope,
): Promise<AgentPolicyRule[]> {
  const rows = await db
    .select()
    .from(agentPolicies)
    .where(
      and(
        eq(agentPolicies.organizationId, scope.organizationId),
        isNull(agentPolicies.disabledAt),
        // A policy scoped to a project or environment applies only there; one scoped to
        // neither applies across the organization.
        or(
          isNull(agentPolicies.projectId),
          scope.projectId ? eq(agentPolicies.projectId, scope.projectId) : sql`false`,
        ),
        or(
          isNull(agentPolicies.projectEnvironmentId),
          scope.projectEnvironmentId
            ? eq(agentPolicies.projectEnvironmentId, scope.projectEnvironmentId)
            : sql`false`,
        ),
      ),
    )
    .orderBy(desc(agentPolicies.priority));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    priority: row.priority,
    effect: row.effect as AgentPolicyRule['effect'],
    actions: row.actions,
    providers: row.providers,
    agentIdentityId: row.agentIdentityId,
    conditions: (row.conditions ?? {}) as PolicyConditions,
    requiredApproverRole: row.requiredApproverRole,
    reasonCode: row.reasonCode,
    disabled: row.disabledAt !== null,
  }));
}

export interface RecordAgentActionInput {
  agentRunId?: string | null;
  agentIdentityId: string;
  organizationId: string;
  projectEnvironmentId: string;
  action: string;
  provider?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  outcome: PolicyOutcome;
  attributes?: Record<string, unknown>;
  traceId?: string | null;
}

/**
 * Record what an agent tried and what the policy engine said.
 *
 * Written for every decision, including refusals. Storing only the permitted ones would
 * erase the evidence of an agent repeatedly attempting something it should not — which is
 * the signal most worth having, and the one nobody thinks to record until they need it.
 */
export async function recordAgentAction(
  db: Database | Transaction,
  input: RecordAgentActionInput,
): Promise<string> {
  const id = newUuidV7();

  await db.insert(agentActions).values({
    id,
    agentRunId: input.agentRunId ?? null,
    agentIdentityId: input.agentIdentityId,
    organizationId: input.organizationId,
    projectEnvironmentId: input.projectEnvironmentId,
    action: input.action,
    provider: input.provider ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    decision: input.outcome.decision,
    policyId: input.outcome.ruleId,
    reasonCode: input.outcome.reasonCode,
    attributes: input.attributes ?? {},
    traceId: input.traceId ?? null,
  });

  return id;
}

export interface CreateApprovalInput {
  organizationId: string;
  projectEnvironmentId: string;
  profileId?: string | null;
  agentIdentityId?: string | null;
  agentActionId?: string | null;
  subjectType: string;
  subjectId: string;
  reasonCode: string;
  requiredApproverRole: string;
  summary?: string | null;
  expiresAt: Date;
  traceId?: string | null;
}

/**
 * Open an approval request.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique index on the subject. Two pending
 * approvals for the same post would let one approver accept while another rejects, with
 * nothing deciding which wins — and a retried request must join the existing approval
 * rather than open a competing one.
 */
export async function createApprovalRequest(
  db: Database,
  input: CreateApprovalInput,
): Promise<{ id: string; created: boolean }> {
  const id = newUuidV7();

  const inserted = await db
    .insert(approvalRequests)
    .values({
      id,
      organizationId: input.organizationId,
      projectEnvironmentId: input.projectEnvironmentId,
      profileId: input.profileId ?? null,
      agentIdentityId: input.agentIdentityId ?? null,
      agentActionId: input.agentActionId ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      reasonCode: input.reasonCode,
      requiredApproverRole: input.requiredApproverRole,
      summary: input.summary ?? null,
      expiresAt: input.expiresAt,
      traceId: input.traceId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: approvalRequests.id });

  if (inserted[0]) return { id: inserted[0].id, created: true };

  const existing = await findPendingApproval(db, input.subjectType, input.subjectId);
  return { id: existing?.id ?? id, created: false };
}

export async function findPendingApproval(
  db: Database,
  subjectType: string,
  subjectId: string,
): Promise<ApprovalRequest | null> {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.subjectType, subjectType),
        eq(approvalRequests.subjectId, subjectId),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function findApprovalById(
  db: Database,
  projectEnvironmentId: string,
  approvalId: string,
): Promise<ApprovalRequest | null> {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.id, approvalId),
        eq(approvalRequests.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function listPendingApprovals(
  db: Database,
  projectEnvironmentId: string,
  limit: number,
): Promise<ApprovalRequest[]> {
  return db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.projectEnvironmentId, projectEnvironmentId),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(limit);
}

/**
 * Approve or reject, conditionally on the request still being pending.
 *
 * The `status = 'pending'` predicate is the whole mechanism. Two approvers acting at once
 * is normal — a notification goes to a team — and without it the second write would
 * silently overwrite the first, so a rejection could land on top of an approval that had
 * already released the post.
 */
export async function decideApproval(
  db: Database,
  input: {
    approvalId: string;
    decision: 'approved' | 'rejected';
    decidedByUserId: string;
    note?: string | null;
  },
): Promise<ApprovalRequest | null> {
  const rows = await db
    .update(approvalRequests)
    .set({
      status: input.decision,
      decidedByUserId: input.decidedByUserId,
      decidedAt: new Date(),
      decisionNote: input.note ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(approvalRequests.id, input.approvalId), eq(approvalRequests.status, 'pending')),
    )
    .returning();

  return rows[0] ?? null;
}

/**
 * Expire requests nobody answered.
 *
 * Run from the reconciler. An approval that waits forever is a post that silently never
 * goes out — the worst failure this product has, because nothing surfaces it. Expiring
 * makes it visible and, unlike waiting, produces an event a customer can alert on.
 */
export async function expireStaleApprovals(db: Database, limit = 200): Promise<ApprovalRequest[]> {
  const due = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      and(eq(approvalRequests.status, 'pending'), lt(approvalRequests.expiresAt, new Date())),
    )
    .limit(limit);

  if (due.length === 0) return [];

  const expired = await db
    .update(approvalRequests)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        lt(approvalRequests.expiresAt, new Date()),
      ),
    )
    .returning();

  return expired;
}

// ---------------------------------------------------------------------------
// Identities and runs
// ---------------------------------------------------------------------------

export async function createAgentIdentity(
  db: Database,
  input: {
    organizationId: string;
    projectId?: string | null;
    name: string;
    description?: string | null;
    operator?: string | null;
  },
): Promise<AgentIdentity> {
  const rows = await db
    .insert(agentIdentities)
    .values({
      id: newUuidV7(),
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      name: input.name,
      description: input.description ?? null,
      operator: input.operator ?? null,
    })
    .returning();

  return rows[0]!;
}

export async function findAgentIdentity(
  db: Database,
  organizationId: string,
  agentIdentityId: string,
): Promise<AgentIdentity | null> {
  const rows = await db
    .select()
    .from(agentIdentities)
    .where(
      and(
        eq(agentIdentities.id, agentIdentityId),
        eq(agentIdentities.organizationId, organizationId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function listAgentIdentities(
  db: Database,
  organizationId: string,
): Promise<AgentIdentity[]> {
  return db
    .select()
    .from(agentIdentities)
    .where(eq(agentIdentities.organizationId, organizationId))
    .orderBy(desc(agentIdentities.createdAt));
}

export async function startAgentRun(
  db: Database,
  input: {
    agentIdentityId: string;
    organizationId: string;
    projectEnvironmentId: string;
    profileId?: string | null;
    objective?: string | null;
    traceId?: string | null;
  },
): Promise<string> {
  const id = newUuidV7();

  await db.insert(agentRuns).values({
    id,
    agentIdentityId: input.agentIdentityId,
    organizationId: input.organizationId,
    projectEnvironmentId: input.projectEnvironmentId,
    profileId: input.profileId ?? null,
    objective: input.objective ?? null,
    traceId: input.traceId ?? null,
  });

  return id;
}

export async function finishAgentRun(
  db: Database,
  runId: string,
  status: 'completed' | 'failed' | 'abandoned',
): Promise<void> {
  await db
    .update(agentRuns)
    .set({ status, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentRuns.id, runId));
}

export interface UpsertPolicyInput {
  organizationId: string;
  projectId?: string | null;
  projectEnvironmentId?: string | null;
  agentIdentityId?: string | null;
  name: string;
  priority: number;
  effect: 'allow' | 'require_approval' | 'deny';
  actions: readonly string[];
  providers?: readonly string[];
  conditions?: Record<string, unknown>;
  requiredApproverRole?: string;
  reasonCode?: string | null;
}

export async function createAgentPolicy(db: Database, input: UpsertPolicyInput): Promise<string> {
  const id = newUuidV7();

  await db.insert(agentPolicies).values({
    id,
    organizationId: input.organizationId,
    projectId: input.projectId ?? null,
    projectEnvironmentId: input.projectEnvironmentId ?? null,
    agentIdentityId: input.agentIdentityId ?? null,
    name: input.name,
    priority: input.priority,
    effect: input.effect,
    actions: [...input.actions],
    providers: [...(input.providers ?? [])],
    conditions: input.conditions ?? {},
    requiredApproverRole: input.requiredApproverRole ?? 'admin',
    reasonCode: input.reasonCode ?? null,
  });

  return id;
}

export async function disableAgentPolicy(
  db: Database,
  organizationId: string,
  policyId: string,
): Promise<boolean> {
  const rows = await db
    .update(agentPolicies)
    .set({ disabledAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(agentPolicies.id, policyId),
        eq(agentPolicies.organizationId, organizationId),
        isNull(agentPolicies.disabledAt),
      ),
    )
    .returning({ id: agentPolicies.id });

  return rows.length > 0;
}
