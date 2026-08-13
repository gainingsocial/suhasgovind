import {
  DraftSetListResponseSchema,
  DraftSetSchema,
  ListDraftSetsQuerySchema,
  PublishDraftSetRequestSchema,
  PublishDraftSetResponseSchema,
  UpdateDraftSetRequestSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import {
  findDraftSetDetail,
  findSpansForExtraction,
  listDraftSets,
  transitionDraftSet,
  updateDraft,
  type DraftSetDetail,
} from '@gs/db';
import { verifyGrounding, type SourceSpan } from '@gs/domain';
import { ApiError } from '@gs/errors';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { parseBody, parseQuery, requirePathId } from '../lib/request.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';

/**
 * Draft sets — review, edit and publish (plan §63N, §63Q, §63T).
 *
 * Publishing does not reimplement publishing. It builds a `POST /v1/posts` body from the
 * drafts and re-enters the API through its own front door, exactly as the MCP layer does.
 * That is not laziness: `POST /v1/posts` is where idempotency, preflight, content
 * fingerprinting and the queue handoff live, and a second path into publishing is a second
 * path that can be wrong about duplicates. The dispatcher is injected rather than imported
 * because the app imports this module, and importing it back would be a cycle.
 *
 * Approval is a transition, not a field. `status` moves through explicit values so that an
 * audit log distinguishes "somebody approved this" from "somebody renamed it" (P20).
 */

export type InternalDispatch = (
  request: Request,
  env: AppEnv['Bindings'],
  ctx: unknown,
) => Promise<Response> | Response;

function serializeDraftSet(detail: DraftSetDetail) {
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

export function createDraftSetRoutes(dispatch: InternalDispatch): Hono<AppEnv> {
  const draftSets = new Hono<AppEnv>();

  draftSets.get('/', withDatabase(), authenticate(['content:read']), async (c) => {
    const principal = c.get('principal');
    const query = parseQuery(c, ListDraftSetsQuerySchema);

    const cursor = query.cursor ? fromPublicId('draftSet', query.cursor) : undefined;
    if (query.cursor && !cursor) {
      throw new ApiError('INVALID_REQUEST', { message: '`cursor` is not valid.', param: 'cursor' });
    }

    const profileId =
      principal.restrictedToProfileId ??
      (query.profile_id ? fromPublicId('profile', query.profile_id) : null);

    if (query.profile_id && !profileId) {
      throw new ApiError('INVALID_REQUEST', {
        message: '`profile_id` is not a valid profile id.',
        param: 'profile_id',
      });
    }

    const rows = await listDraftSets(c.get('db'), {
      projectEnvironmentId: principal.projectEnvironmentId,
      limit: query.limit + 1,
      ...(cursor ? { cursor } : {}),
      ...(profileId ? { profileId } : {}),
      ...(query.status ? { status: query.status } : {}),
    });

    const page = rows.slice(0, query.limit);
    const hasMore = rows.length > query.limit;
    const last = page[page.length - 1];

    // The list omits the drafts themselves — a set of twenty drafts is a large payload and
    // a list view shows a title and a status. `GET /v1/draft-sets/{id}` returns the whole
    // thing including its grounding.
    const data = await Promise.all(
      page.map(async (set) => {
        const detail = await findDraftSetDetail(
          c.get('db'),
          principal.projectEnvironmentId,
          set.id,
        );
        return {
          id: toPublicId('draftSet', set.id),
          object: 'draft_set' as const,
          status: set.status,
          profile_id: toPublicId('profile', set.profileId),
          title: set.title,
          grounding_failed: set.groundingFailed,
          draft_count: detail?.drafts.length ?? 0,
          created_at: set.createdAt.toISOString(),
          updated_at: set.updatedAt.toISOString(),
        };
      }),
    );

    return c.json(
      DraftSetListResponseSchema.parse({
        object: 'list',
        data,
        has_more: hasMore,
        next_cursor: hasMore && last ? toPublicId('draftSet', last.id) : null,
      }),
      200,
    );
  });

  draftSets.get('/:draftSetId', withDatabase(), authenticate(['content:read']), async (c) => {
    const detail = await loadOwnedDraftSet(c, requirePathId(c, 'draftSet', 'draftSetId'));
    return c.json(serializeDraftSet(detail), 200);
  });

  draftSets.patch('/:draftSetId', withDatabase(), authenticate(['content:write']), async (c) => {
    const principal = c.get('principal');
    const draftSetId = requirePathId(c, 'draftSet', 'draftSetId');
    const body = await parseBody(c, UpdateDraftSetRequestSchema);

    const detail = await loadOwnedDraftSet(c, draftSetId);

    if (detail.set.status === 'published') {
      throw new ApiError('CONFLICTING_STATE', {
        message: 'A published draft set cannot be edited. Create a new one.',
      });
    }

    const byId = new Map(detail.drafts.map((draft) => [draft.id, draft]));

    for (const edit of body.drafts ?? []) {
      const internalId = fromPublicId('draft', edit.id);
      const draft = internalId ? byId.get(internalId) : undefined;
      if (!draft || !internalId) {
        throw new ApiError('RESOURCE_NOT_FOUND', {
          message: `No draft ${edit.id} in this set.`,
        });
      }

      /**
       * An edited body invalidates the grounding that was verified against the old text.
       * Re-verifying here — rather than leaving the old claims in place — is the
       * difference between a citation that means something and one that merely exists
       * (P18). A claim whose text no longer appears in the draft is recorded as
       * unverified, not silently dropped.
       */
      let claims: Parameters<typeof updateDraft>[2]['claims'];
      if (edit.body !== undefined) {
        const spans = await sourceSpansFor(c, detail);
        const nextBody = edit.body;

        /**
         * A claim survives an edit only if its text is still in the draft *and* it still
         * grounds. Dropping the first test would leave a verified claim attached to a
         * sentence the author deleted; dropping the second would trust a citation that was
         * checked against different words.
         */
        const retained = draft.claims.filter((claim) => nextBody.includes(claim.claimText));
        const result = verifyGrounding(
          retained.map((claim) => ({
            text: claim.claimText,
            sourceSpanIds: claim.sourceSpanIds,
          })),
          spans,
        );

        const groundedTexts = new Set(result.grounded.map((claim) => claim.text));
        const failureByText = new Map(
          result.failures.map((failure) => [failure.claim, failure.reason]),
        );

        claims = retained.map((claim) => ({
          claimText: claim.claimText,
          claimKind: claim.claimKind,
          sourceSpanIds: claim.sourceSpanIds,
          verified: groundedTexts.has(claim.claimText),
          failureReason: failureByText.get(claim.claimText) ?? null,
        }));
      }

      await updateDraft(c.get('db'), internalId, {
        ...(edit.body !== undefined ? { body: edit.body } : {}),
        ...(edit.media_ids !== undefined
          ? {
              mediaIds: edit.media_ids.map((id) => {
                const resolved = fromPublicId('media', id);
                if (!resolved) {
                  throw new ApiError('INVALID_REQUEST', {
                    message: `\`${id}\` is not a valid media id.`,
                    param: 'drafts[].media_ids',
                  });
                }
                return resolved;
              }),
            }
          : {}),
        ...(claims ? { claims } : {}),
      });
    }

    if (body.status) {
      const allowedFrom =
        body.status === 'approved'
          ? (['draft', 'ready_for_review'] as const)
          : body.status === 'ready_for_review'
            ? (['draft'] as const)
            : (['draft', 'ready_for_review', 'approved'] as const);

      const moved = await transitionDraftSet(
        c.get('db'),
        principal.projectEnvironmentId,
        draftSetId,
        [...allowedFrom],
        body.status,
      );

      if (!moved) {
        throw new ApiError('CONFLICTING_STATE', {
          message: `This draft set cannot move to \`${body.status}\` from \`${detail.set.status}\`.`,
        });
      }
    }

    return c.json(serializeDraftSet(await loadOwnedDraftSet(c, draftSetId)), 200);
  });

  /**
   * Validate every draft against its destination without publishing.
   *
   * Delegates to `POST /v1/posts/preflight` for the same reason publishing delegates: the
   * rules a destination enforces live in one place, and a second implementation of them
   * would drift the first time a platform changed a limit.
   */
  draftSets.post(
    '/:draftSetId/preflight',
    withDatabase(),
    authenticate(['content:read', 'posts:read']),
    async (c) => {
      const detail = await loadOwnedDraftSet(c, requirePathId(c, 'draftSet', 'draftSetId'));
      const response = await dispatchPost(c, dispatch, '/v1/posts/preflight', buildPostBody(detail));
      return response;
    },
  );

  draftSets.post(
    '/:draftSetId/publish',
    withDatabase(),
    authenticate(['content:write', 'posts:write']),
    async (c) => {
      const principal = c.get('principal');
      const draftSetId = requirePathId(c, 'draftSet', 'draftSetId');
      const body = PublishDraftSetRequestSchema.parse(
        c.req.header('content-type')?.includes('json') ? await c.req.json() : {},
      );

      const detail = await loadOwnedDraftSet(c, draftSetId);

      if (detail.set.status === 'published') {
        throw new ApiError('CONFLICTING_STATE', {
          message: 'This draft set has already been published.',
        });
      }

      /**
       * Grounding is a hard gate, not a warning.
       *
       * P18 is the whole argument for generated content being publishable at all: every
       * factual claim traces to something the source said. A set that failed that check
       * may be edited and re-verified, but it may not be published as it stands — and this
       * is enforced here rather than left to the automation mode, because a customer who
       * chose `auto_publish_if_safe` was asserting a preference, not overriding a proof.
       */
      if (detail.set.groundingFailed) {
        throw new ApiError('VALIDATION_FAILED', {
          message:
            'This draft set contains a claim that could not be traced to the source. Edit the ' +
            'draft so every claim is grounded, or publish the drafts individually after review.',
          agentAction: 'edit_ungrounded_claims',
        });
      }

      const selected = body.draft_ids
        ? detail.drafts.filter((draft) =>
            body.draft_ids?.some((id) => fromPublicId('draft', id) === draft.id),
          )
        : detail.drafts;

      if (selected.length === 0) {
        throw new ApiError('INVALID_REQUEST', {
          message: 'No drafts selected to publish.',
          param: 'draft_ids',
        });
      }

      const postBody = buildPostBody({ ...detail, drafts: selected });
      if (body.publish_at !== undefined) postBody.publish_at = body.publish_at ?? null;

      const response = await dispatchPost(c, dispatch, '/v1/posts', postBody);
      if (!response.ok) return response;

      const created = (await response.json()) as { id: string };

      // Only after the post exists. Marking the set published first would leave a set
      // claiming a post that a validation failure meant never got created.
      const moved = await transitionDraftSet(
        c.get('db'),
        principal.projectEnvironmentId,
        draftSetId,
        ['draft', 'ready_for_review', 'approved'],
        'published',
      );

      if (!moved) {
        throw new ApiError('CONFLICTING_STATE', {
          message: 'This draft set was published concurrently by another request.',
        });
      }

      return c.json(
        PublishDraftSetResponseSchema.parse({
          id: toPublicId('draftSet', draftSetId),
          object: 'draft_set',
          status: 'published',
          post_id: created.id,
          published_draft_count: selected.length,
        }),
        202,
      );
    },
  );

  return draftSets;
}

/** Load a draft set, or fail the way an unowned one does — indistinguishably (P5). */
async function loadOwnedDraftSet(c: Ctx, draftSetId: string): Promise<DraftSetDetail> {
  const principal = c.get('principal');
  const detail = await findDraftSetDetail(c.get('db'), principal.projectEnvironmentId, draftSetId);
  if (!detail) throw new ApiError('DRAFT_SET_NOT_FOUND');

  if (
    principal.restrictedToProfileId &&
    principal.restrictedToProfileId !== detail.set.profileId
  ) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  return detail;
}

type Ctx = Context<AppEnv>;

interface PostBody {
  profile_id: string;
  content: { text: string; media_ids: string[] };
  targets: { destination_id: string; overrides?: { text: string; media_ids: string[] } }[];
  publish_at?: string | null;
}

/**
 * Turn a set of drafts into one post with per-destination overrides.
 *
 * One post, not one per draft. They are the same piece of writing adapted per network,
 * which is exactly what a logical post with N targets models (P2) — and it means the set
 * reports partial success the same way any other post does.
 *
 * The first draft's body becomes the base content and every draft carries its own
 * override, including the first. Being explicit costs a few bytes and removes the question
 * of whether the base applies to the destination that produced it.
 */
function buildPostBody(detail: DraftSetDetail): PostBody {
  const publishable = detail.drafts.filter((draft) => draft.destinationId !== null);

  if (publishable.length === 0) {
    throw new ApiError('VALIDATION_FAILED', {
      message:
        'No draft in this set has a destination. A draft without one was generated for a ' +
        'platform rather than for a connected account, and cannot be published.',
      agentAction: 'assign_destinations_to_drafts',
    });
  }

  const first = publishable[0]!;

  return {
    profile_id: toPublicId('profile', detail.set.profileId),
    content: {
      text: first.body,
      media_ids: first.mediaIds.map((id) => toPublicId('media', id)),
    },
    targets: publishable.map((draft) => ({
      destination_id: toPublicId('destination', draft.destinationId!),
      overrides: {
        text: draft.body,
        media_ids: draft.mediaIds.map((id) => toPublicId('media', id)),
      },
    })),
  };
}

/**
 * Re-enter the API through its own front door.
 *
 * The caller's `Authorization` header is forwarded verbatim, so the inner request is
 * authorized exactly as a direct one would be — a draft set cannot become a way to publish
 * with scopes the key does not hold.
 */
async function dispatchPost(
  c: Ctx,
  dispatch: InternalDispatch,
  path: string,
  body: PostBody,
): Promise<Response> {
  const trace = c.get('trace');
  const origin = c.env.PUBLIC_API_ORIGIN ?? new URL(c.req.url).origin;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': trace.requestId,
    'x-trace-id': trace.traceId,
  };

  const authorization = c.req.header('authorization');
  if (authorization) headers.authorization = authorization;

  if (path === '/v1/posts') {
    /**
     * Derived from the draft set, not random.
     *
     * Publishing the same set twice — a double-click, a retried request — must not produce
     * two posts, and a random key would make each attempt look new. The set id is the
     * natural identity of "this content, published once" (ADR-006 Layer 1).
     */
    headers['idempotency-key'] = `dfs_${body.profile_id}_${body.targets.length}_${
      c.req.param('draftSetId') ?? ''
    }`;
  }

  return dispatch(
    new Request(new URL(path, origin).toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    c.env,
    c.executionCtx,
  );
}

/**
 * The spans a set's claims are grounded in.
 *
 * Resolved through the extraction back to the version it read, because a span id is only
 * meaningful against the exact version it was produced from — the same id in a later
 * version points at different words. A set whose extraction has been removed grounds
 * against nothing, which correctly makes every claim unverifiable rather than silently
 * passing.
 */
async function sourceSpansFor(
  c: Ctx,
  detail: DraftSetDetail,
): Promise<SourceSpan[]> {
  if (!detail.set.contentExtractionId) return [];

  const principal = c.get('principal');
  return findSpansForExtraction(
    c.get('db'),
    principal.projectEnvironmentId,
    detail.set.contentExtractionId,
  );
}
