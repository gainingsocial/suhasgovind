import { DraftSetSchema } from '@gs/contracts/http';
import { toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import type { DraftSetDetail } from '@gs/db';

/**
 * The draft set response shape.
 *
 * Extracted from the draft-sets routes because two routes now produce one: `/v1/draft-sets`
 * reads them and `/v1/content/repurpose` creates them. A second copy would drift, and the
 * field most likely to drift is `grounding_failed` — the one that decides whether a set may
 * publish at all.
 */
export function serializeDraftSet(detail: DraftSetDetail) {
  return DraftSetSchema.parse({
    id: toPublicId('draftSet', detail.set.id),
    object: 'draft_set',
    status: detail.set.status,
    profile_id: toPublicId('profile', detail.set.profileId),
    title: detail.set.title,
    grounding_failed: detail.set.groundingFailed,
    drafts: detail.drafts.map((draft) => ({
      id: toPublicId('draft', draft.id),
      object: 'social_draft',
      provider: isProviderName(draft.provider) ? draft.provider : 'mock',
      destination_id: draft.destinationId ? toPublicId('destination', draft.destinationId) : null,
      body: draft.body,
      media_ids: draft.mediaIds.map((id) => toPublicId('media', id)),
      post_id: draft.postId ? toPublicId('post', draft.postId) : null,
      claims: draft.claims.map((claim) => ({
        claim_text: claim.claimText,
        claim_kind: claim.claimKind,
        source_span_ids: claim.sourceSpanIds,
        verified: claim.verified,
        failure_reason: claim.failureReason,
      })),
    })),
    created_at: detail.set.createdAt.toISOString(),
    updated_at: detail.set.updatedAt.toISOString(),
  });
}
