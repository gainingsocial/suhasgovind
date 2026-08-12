import {
  ApprovalListResponseSchema,
  ApprovalSchema,
  DecideApprovalRequestSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import {
  cancelPostTargets,
  decideApproval,
  enqueueTargets,
  findApprovalById,
  findMembershipForEnvironment,
  getPostWithTargets,
  listEnvironmentsForUser,
  listPendingApprovals,
  recalculatePostStatus,
  type ApprovalRequest,
  type Database,
} from '@gs/db';
import { ApiError } from '@gs/errors';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { parseBody, requirePathId } from '../lib/request.js';
import { authenticateHuman } from '../middleware/authenticate-human.js';
import { withDatabase } from '../middleware/database.js';

/**
 * The approval control plane (plan Phase 9).
 *
 * Where a held agent action waits for a person, and where that person decides.
 *
 * Authenticated by a **human session**, never by an API key. An approval an agent could
 * grant itself is not an approval — and agents authenticate with API keys, so allowing one
 * here would make the entire policy engine decorative.
 */
export const approvals = new Hono<AppEnv>();

/**
 * Which organization roles satisfy each required approver role.
 *
 * A more senior role always satisfies a less senior requirement, so "an admin must sign
 * this off" is not blocked by the owner being the only person available.
 */
const APPROVER_ROLES: Record<string, readonly string[]> = {
  owner: ['owner'],
  admin: ['owner', 'admin'],
  marketer: ['owner', 'admin', 'marketer'],
};

const APPROVAL_PAGE_SIZE = 50;

function toResponse(row: ApprovalRequest) {
  return ApprovalSchema.parse({
    id: toPublicId('approval', row.id),
    object: 'approval_request',
    subject_type: row.subjectType,
    subject_id: row.subjectType === 'post' ? toPublicId('post', row.subjectId) : row.subjectId,
    status: row.status,
    reason_code: row.reasonCode,
    required_approver_role: row.requiredApproverRole,
    summary: row.summary,
    decided_at: row.decidedAt?.toISOString() ?? null,
    decision_note: row.decisionNote,
    // Rule 15 — UTC ISO-8601 everywhere.
    expires_at: row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
  });
}

function requireEnvironmentId(value: string | undefined): string {
  const environmentId = fromPublicId('environment', value ?? '');

  if (!environmentId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`environment_id` is required and must be a valid environment id.',
      param: 'environment_id',
    });
  }

  return environmentId;
}

/**
 * Find an approval, searching only environments the caller belongs to.
 *
 * An approval id is opaque, but "does this id exist" is still information. Scoping the
 * search to the caller's own memberships makes a stranger's id indistinguishable from a
 * nonexistent one (P5).
 */
async function findOwnedApproval(
  db: Database,
  userId: string,
  approvalId: string,
): Promise<ApprovalRequest | null> {
  const environments = await listEnvironmentsForUser(db, userId);

  for (const membership of environments) {
    const found = await findApprovalById(db, membership.projectEnvironmentId, approvalId);
    if (found) return found;
  }

  return null;
}

/**
 * Release or cancel the post an approval was holding.
 *
 * Runs only after the decision is committed. Enqueuing first would mean a crash between
 * the two leaves a post published against an approval that still reads pending — and the
 * audit trail would then be wrong in the one direction that matters.
 */
async function applyPostDecision(
  db: Database,
  approval: ApprovalRequest,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const found = await getPostWithTargets(db, approval.subjectId);
  if (!found) return;

  if (decision === 'rejected') {
    await cancelPostTargets(db, { postId: approval.subjectId });
  } else {
    await enqueueTargets(db, { postId: approval.subjectId });
  }

  await recalculatePostStatus(db, approval.subjectId);
}

approvals.get('/', withDatabase(), authenticateHuman(), async (c: Context<AppEnv>) => {
  const user = c.get('user');
  const environmentId = requireEnvironmentId(c.req.query('environment_id'));

  const membership = await findMembershipForEnvironment(c.get('db'), user.userId, environmentId);
  if (!membership) throw new ApiError('TENANT_FORBIDDEN');

  const rows = await listPendingApprovals(c.get('db'), environmentId, APPROVAL_PAGE_SIZE + 1);
  const page = rows.slice(0, APPROVAL_PAGE_SIZE);

  return c.json(
    ApprovalListResponseSchema.parse({
      object: 'list',
      data: page.map(toResponse),
      has_more: rows.length > APPROVAL_PAGE_SIZE,
      next_cursor: null,
    }),
    200,
  );
});

approvals.post('/:approvalId/decide', withDatabase(), authenticateHuman(), async (c: Context<AppEnv>) => {
  const user = c.get('user');
  const approvalId = requirePathId(c, 'approval', 'approvalId');
  const body = await parseBody(c, DecideApprovalRequestSchema);

  const existing = await findOwnedApproval(c.get('db'), user.userId, approvalId);
  if (!existing) throw new ApiError('RESOURCE_NOT_FOUND', { message: 'No such approval request.' });

  const membership = await findMembershipForEnvironment(
    c.get('db'),
    user.userId,
    existing.projectEnvironmentId,
  );
  if (!membership) throw new ApiError('TENANT_FORBIDDEN');

  /**
   * The role the *policy* demanded, carried on the request itself.
   *
   * A rule saying "an admin must sign this off" is worthless if a marketer can approve it.
   * Reading the requirement from the request rather than re-deriving it means editing a
   * policy later cannot retroactively lower the bar on work already held under the old one.
   */
  const permitted = APPROVER_ROLES[existing.requiredApproverRole] ?? ['owner', 'admin'];
  if (!permitted.includes(membership.role)) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: `This approval requires the ${existing.requiredApproverRole} role; yours is ${membership.role}.`,
    });
  }

  if (existing.status !== 'pending') {
    throw new ApiError('APPROVAL_ALREADY_DECIDED', {
      message: `This request was already ${existing.status}.`,
    });
  }

  const decided = await decideApproval(c.get('db'), {
    approvalId,
    decision: body.decision,
    decidedByUserId: user.userId,
    note: body.note ?? null,
  });

  if (!decided) {
    /**
     * Lost the race with another approver between the read and the write.
     *
     * Two people acting at once is normal — the notification goes to a team — and the
     * conditional UPDATE is what stops a rejection landing on top of an approval that has
     * already released the post.
     */
    throw new ApiError('APPROVAL_ALREADY_DECIDED', {
      message: 'Another approver decided this request first.',
    });
  }

  if (decided.subjectType === 'post') {
    await applyPostDecision(c.get('db'), decided, body.decision);
  }

  return c.json(toResponse(decided), 200);
});
