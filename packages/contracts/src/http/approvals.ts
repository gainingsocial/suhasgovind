import { z } from 'zod';

/**
 * The approval control plane (plan Phase 9).
 *
 * What an agent proposed, why it was held, and who may release it.
 */
export const ApprovalSchema = z
  .object({
    id: z.string(),
    object: z.literal('approval_request'),
    /** What is being approved. `post` today; `reply` and `campaign` later. */
    subject_type: z.string(),
    subject_id: z.string(),
    status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']),
    /** Stable machine code for why this was held, e.g. `SENSITIVE_TOPIC`. */
    reason_code: z.string().nullable(),
    /**
     * The role the policy demanded. Carried on the request rather than re-derived, so
     * editing a policy later cannot retroactively lower the bar on work already held.
     */
    required_approver_role: z.string(),
    /** A précis, so an approver does not have to open the resource to decide. */
    summary: z.string().nullable(),
    decided_at: z.iso.datetime().nullable(),
    decision_note: z.string().nullable(),
    /**
     * Mandatory. An approval that never expires becomes a post that silently never
     * publishes, which is the worst failure this product has.
     */
    expires_at: z.iso.datetime(),
    created_at: z.iso.datetime(),
  })
  .strict();

export const ApprovalListResponseSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(ApprovalSchema),
    has_more: z.boolean(),
    next_cursor: z.null(),
  })
  .strict();

export const DecideApprovalRequestSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    /** Recorded on the request, so a later reader knows why rather than only what. */
    note: z.string().max(2000).optional(),
  })
  .strict();

export type Approval = z.infer<typeof ApprovalSchema>;
