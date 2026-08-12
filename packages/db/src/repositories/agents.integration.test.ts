import { evaluatePolicy } from '@gs/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseHandle, type Database, type DatabaseHandle } from '../client.js';
import { createTenantHarness, databaseUrl, type TenantHarness } from '../test-support/seed.js';
import {
  createAgentIdentity,
  createAgentPolicy,
  createApprovalRequest,
  decideApproval,
  disableAgentPolicy,
  expireStaleApprovals,
  findPendingApproval,
  listPendingApprovals,
  loadAgentPolicies,
  recordAgentAction,
} from './agents.js';

/**
 * Agent governance persistence (plan §51, Phase 9).
 *
 * The decision logic is unit-tested exhaustively in `@gs/domain`. What needs a real
 * database is the part that involves two people acting at once and two tenants sharing a
 * table: an approval must not be decided twice, and one organization's policies must never
 * reach another's agent.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('agent governance', () => {
  let h: TenantHarness;
  let handle: DatabaseHandle;
  let db: Database;
  let agentId: string;

  beforeAll(async () => {
    h = await createTenantHarness([]);
    handle = createDatabaseHandle({ connectionString: h.connectionString, max: 2 });
    db = handle.db;

    const identity = await createAgentIdentity(db, {
      organizationId: h.tenantA.organizationId,
      name: `test-agent-${Date.now()}`,
      operator: 'integration suite',
    });
    agentId = identity.id;
  });

  afterAll(async () => {
    await handle?.close();
    await h?.cleanup();
  });

  const scope = () => ({
    organizationId: h.tenantA.organizationId,
    projectId: h.tenantA.projectId,
    projectEnvironmentId: h.tenantA.projectEnvironmentId,
  });

  describe('policies', () => {
    it('loads a policy and evaluates it against an action', async () => {
      await createAgentPolicy(db, {
        organizationId: h.tenantA.organizationId,
        name: 'Agents may not delete',
        priority: 100,
        effect: 'deny',
        actions: ['posts:delete'],
        reasonCode: 'DELETION_IS_NOT_DELEGATED',
      });

      const rules = await loadAgentPolicies(db, scope());
      const outcome = evaluatePolicy(rules, {
        action: 'posts:delete',
        agentIdentityId: agentId,
      });

      expect(outcome).toMatchObject({ decision: 'denied', reasonCode: 'DELETION_IS_NOT_DELEGATED' });
    });

    it('never loads another organization’s policies', async () => {
      // A policy leaking across tenants would apply one customer's governance to another's
      // agent — either blocking work they permitted or permitting work they forbade.
      await createAgentPolicy(db, {
        organizationId: h.tenantA.organizationId,
        name: 'Tenant A only',
        priority: 5,
        effect: 'allow',
        actions: ['posts:create'],
      });

      const other = await loadAgentPolicies(db, {
        organizationId: h.tenantB.organizationId,
        projectId: h.tenantB.projectId,
        projectEnvironmentId: h.tenantB.projectEnvironmentId,
      });

      expect(other.map((rule) => rule.name)).not.toContain('Tenant A only');
    });

    it('stops applying a policy once it is disabled', async () => {
      const policyId = await createAgentPolicy(db, {
        organizationId: h.tenantA.organizationId,
        name: 'Temporary block',
        priority: 500,
        effect: 'deny',
        actions: ['posts:create'],
      });

      const before = await loadAgentPolicies(db, scope());
      expect(
        evaluatePolicy(before, { action: 'posts:create', agentIdentityId: agentId }).decision,
      ).toBe('denied');

      expect(await disableAgentPolicy(db, h.tenantA.organizationId, policyId)).toBe(true);

      const after = await loadAgentPolicies(db, scope());
      expect(after.map((rule) => rule.id)).not.toContain(policyId);
    });

    it('scopes an environment policy to that environment', async () => {
      await createAgentPolicy(db, {
        organizationId: h.tenantA.organizationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        name: 'Environment scoped',
        priority: 7,
        effect: 'allow',
        actions: ['posts:create'],
      });

      const inScope = await loadAgentPolicies(db, scope());
      expect(inScope.map((rule) => rule.name)).toContain('Environment scoped');

      // Same organization, different environment: the row must not apply.
      const elsewhere = await loadAgentPolicies(db, {
        organizationId: h.tenantA.organizationId,
        projectEnvironmentId: h.tenantB.projectEnvironmentId,
      });
      expect(elsewhere.map((rule) => rule.name)).not.toContain('Environment scoped');
    });
  });

  describe('the action log', () => {
    it('records refusals, not only permitted actions', async () => {
      // An agent repeatedly attempting something it should not is the signal most worth
      // having, and the one nobody thinks to record until they need it.
      const actionId = await recordAgentAction(db, {
        agentIdentityId: agentId,
        organizationId: h.tenantA.organizationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        action: 'posts:delete',
        outcome: {
          decision: 'denied',
          ruleId: null,
          ruleName: null,
          reasonCode: 'DELETION_IS_NOT_DELEGATED',
          requiredApproverRole: null,
        },
      });

      expect(actionId).toBeTruthy();
    });
  });

  describe('approvals', () => {
    const subject = () => crypto.randomUUID();

    async function open(subjectId: string) {
      return createApprovalRequest(db, {
        organizationId: h.tenantA.organizationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        agentIdentityId: agentId,
        subjectType: 'post',
        subjectId,
        reasonCode: 'PUBLISHING_REQUIRES_APPROVAL',
        requiredApproverRole: 'admin',
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    }

    it('opens a request', async () => {
      const result = await open(subject());
      expect(result.created).toBe(true);
    });

    it('joins the existing request rather than opening a competing one', async () => {
      // Two pending approvals for one post would let an approver accept while another
      // rejects, with nothing deciding which wins.
      const subjectId = subject();

      const first = await open(subjectId);
      const second = await open(subjectId);

      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
    });

    it('can be decided exactly once', async () => {
      const subjectId = subject();
      const { id } = await open(subjectId);

      const approved = await decideApproval(db, {
        approvalId: id,
        decision: 'approved',
        decidedByUserId: crypto.randomUUID(),
      });
      expect(approved?.status).toBe('approved');

      // The second decision finds nothing pending. This is what stops a rejection landing
      // on top of an approval that has already released the post.
      const second = await decideApproval(db, {
        approvalId: id,
        decision: 'rejected',
        decidedByUserId: crypto.randomUUID(),
      });
      expect(second).toBeNull();
    });

    it('frees the subject for a new request once decided', async () => {
      const subjectId = subject();
      const { id } = await open(subjectId);

      await decideApproval(db, {
        approvalId: id,
        decision: 'rejected',
        decidedByUserId: crypto.randomUUID(),
      });

      expect(await findPendingApproval(db, 'post', subjectId)).toBeNull();

      const reopened = await open(subjectId);
      expect(reopened.created).toBe(true);
    });

    it('lists what is waiting for this environment only', async () => {
      const subjectId = subject();
      await open(subjectId);

      const mine = await listPendingApprovals(db, h.tenantA.projectEnvironmentId, 50);
      expect(mine.map((row) => row.subjectId)).toContain(subjectId);

      const theirs = await listPendingApprovals(db, h.tenantB.projectEnvironmentId, 50);
      expect(theirs.map((row) => row.subjectId)).not.toContain(subjectId);
    });

    it('expires a request nobody answered', async () => {
      // An approval that waits forever is a post that silently never goes out — the worst
      // failure this product has, because nothing surfaces it.
      const subjectId = subject();

      await createApprovalRequest(db, {
        organizationId: h.tenantA.organizationId,
        projectEnvironmentId: h.tenantA.projectEnvironmentId,
        subjectType: 'post',
        subjectId,
        reasonCode: 'PUBLISHING_REQUIRES_APPROVAL',
        requiredApproverRole: 'admin',
        expiresAt: new Date(Date.now() - 1_000),
      });

      const expired = await expireStaleApprovals(db);
      expect(expired.map((row) => row.subjectId)).toContain(subjectId);
      expect(await findPendingApproval(db, 'post', subjectId)).toBeNull();
    });

    it('does not expire a request that still has time', async () => {
      const subjectId = subject();
      await open(subjectId);

      await expireStaleApprovals(db);
      expect(await findPendingApproval(db, 'post', subjectId)).not.toBeNull();
    });
  });
});
