import {
  CancelPostResponseSchema,
  CreatePostRequestSchema,
  ListPostsQuerySchema,
  PostListResponseSchema,
  PostTimelineResponseSchema,
  PreflightRequestSchema,
  PreflightResponseSchema,
  RetryPostResponseSchema,
  RetryTargetResponseSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import {
  cancelPostTargets,
  createPostWithTargets,
  findDestinationOwnerships,
  findProfileById,
  getPostWithTargets,
  listPostAttempts,
  listPosts,
  recalculatePostStatus,
  requeueFailedTargets,
  requeueTarget,
  type DestinationOwnership,
} from '@gs/db';
import { buildFingerprintInput, canonicalizeForHashing } from '@gs/domain';
import { ApiError } from '@gs/errors';
import { sha256Hex } from '@gs/crypto';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';
import { providerCallContext } from '../lib/provider-context.js';
import { idempotencyKey, parseBody, parseQuery, requirePathId } from '../lib/request.js';
import { runPreflight, type PreflightTargetInput } from '../services/preflight.js';
import { buildPostTimeline } from '../services/timeline.js';
import { toPostResponse, toPostSummary } from './post-serializers.js';

/**
 * Publishing (plan §14, §15, §24).
 *
 * `POST /v1/posts` returns **202**, always. Rule 10 forbids long-running work in the
 * request path, and plan §15 is explicit that reliable publication must never depend on
 * the client holding an HTTP connection open. The route validates, reserves idempotency,
 * writes the post and its targets in one transaction, and enqueues. Nothing here talks to
 * a social network.
 */
export const posts = new Hono<AppEnv>();

/** Preflight is cheap and callers are encouraged to hit it; it still needs a deadline. */
const PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * How this environment executes (plan §49).
 *
 * Read from the authenticated principal, which carries it from the environment join the
 * key lookup already performs — never from the request. A caller who could ask for
 * `mode: live` could escalate out of a sandbox, which is the one thing a sandbox is for.
 */
function environmentMode(c: Context<AppEnv>): 'live' | 'simulate' {
  return c.get('principal').simulationMode ? 'simulate' : 'live';
}

interface ResolvedTargets {
  ownerships: Map<string, DestinationOwnership>;
  targets: PreflightTargetInput[];
}

/**
 * Resolve caller-supplied destination ids and verify every one belongs to this tenant
 * (plan §24.1 step 6, P5).
 *
 * Checked before anything is written. A post that is created and then found to reference
 * another tenant's destination has already leaked the fact that the id exists, and
 * unwinding it is far worse than refusing up front.
 */
async function resolveTargets(
  c: Context<AppEnv>,
  profileId: string,
  requested: readonly { destination_id: string; overrides?: unknown; options?: unknown }[],
): Promise<ResolvedTargets> {
  const principal = c.get('principal');

  const seen = new Set<string>();
  const targets: PreflightTargetInput[] = [];

  for (const target of requested) {
    const internalId = fromPublicId('destination', target.destination_id);
    if (!internalId) {
      throw new ApiError('INVALID_REQUEST', {
        message: `\`${target.destination_id}\` is not a valid destination id.`,
        param: 'targets.destination_id',
      });
    }

    // The same destination twice would publish twice — the exact duplicate the whole
    // effective-once design exists to prevent, arriving through the front door.
    if (seen.has(internalId)) {
      throw new ApiError('DUPLICATE_DESTINATION', {
        message: `Destination ${target.destination_id} appears more than once.`,
        param: 'targets.destination_id',
      });
    }
    seen.add(internalId);

    targets.push({
      destinationId: internalId,
      publicDestinationId: target.destination_id,
      overrides: (target.overrides ?? null) as Record<string, unknown> | null,
      options: (target.options ?? null) as Record<string, Record<string, unknown>> | null,
    });
  }

  const ownerships = await findDestinationOwnerships(
    c.get('db'),
    targets.map((t) => t.destinationId),
  );

  for (const [, ownership] of ownerships) {
    const wrongTenant =
      ownership.projectEnvironmentId !== principal.projectEnvironmentId ||
      ownership.projectId !== principal.projectId ||
      ownership.organizationId !== principal.organizationId;

    // Cross-tenant and cross-profile are refused identically, so probing cannot
    // distinguish "exists elsewhere" from "belongs to another profile here".
    if (wrongTenant || ownership.profileId !== profileId) {
      throw new ApiError('TENANT_FORBIDDEN', {
        message: 'A destination does not belong to this profile.',
        param: 'targets.destination_id',
      });
    }
  }

  return { ownerships, targets };
}

/** Resolve and authorize the caller-named profile. */
async function resolveOwnedProfile(c: Context<AppEnv>, publicProfileId: string): Promise<string> {
  const principal = c.get('principal');

  const profileId = fromPublicId('profile', publicProfileId);
  if (!profileId) {
    throw new ApiError('INVALID_REQUEST', {
      message: '`profile_id` is not a valid profile id.',
      param: 'profile_id',
    });
  }

  if (principal.restrictedToProfileId !== null && principal.restrictedToProfileId !== profileId) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  const profile = await findProfileById(c.get('db'), principal.projectEnvironmentId, profileId);
  if (!profile) throw new ApiError('PROFILE_NOT_FOUND');

  return profileId;
}

posts.post('/preflight', withDatabase(), authenticate(['posts:read']), async (c) => {
  const principal = c.get('principal');
  const body = await parseBody(c, PreflightRequestSchema);
  const profileId = await resolveOwnedProfile(c, body.profile_id);
  const { ownerships, targets } = await resolveTargets(c, profileId, body.targets);

  const outcome = await runPreflight({
    db: c.get('db'),
    context: providerCallContext(c, { timeoutMs: PREFLIGHT_TIMEOUT_MS }),
    projectEnvironmentId: principal.projectEnvironmentId,
    organizationId: principal.organizationId,
    projectId: principal.projectId,
    profileId,
    content: body.content,
    targets,
    ownerships,
    publishAt: body.publish_at ? new Date(body.publish_at) : null,
  });

  // 200 even when invalid. Preflight succeeded at its job — reporting problems is the
  // job. A 4xx here would make "your content has a warning" indistinguishable from
  // "your request was malformed".
  return c.json(
    PreflightResponseSchema.parse({ object: 'preflight', valid: outcome.valid, targets: outcome.targets }),
    200,
  );
});

posts.post('/', withDatabase(), authenticate(['posts:write']), async (c) => {
  const principal = c.get('principal');
  const trace = c.get('trace');
  const mode = environmentMode(c);
  const body = await parseBody(c, CreatePostRequestSchema);

  // Plan §25 Layer 1. Required, not optional: a duplicate published post cannot be
  // undone, so the caller has to give us something to deduplicate on.
  const key = idempotencyKey(c);
  if (!key) {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', {
      message: 'POST /v1/posts requires an `Idempotency-Key` header.',
    });
  }

  const profileId = await resolveOwnedProfile(c, body.profile_id);
  const { ownerships, targets } = await resolveTargets(c, profileId, body.targets);

  // Plan §24.1 step 7 — fast preflight before anything is written. A post that cannot
  // publish should never reach the queue, where its failure becomes asynchronous and far
  // harder for the caller to connect to their request.
  const preflight = await runPreflight({
    db: c.get('db'),
    context: providerCallContext(c, { timeoutMs: PREFLIGHT_TIMEOUT_MS }),
    projectEnvironmentId: principal.projectEnvironmentId,
    organizationId: principal.organizationId,
    projectId: principal.projectId,
    profileId,
    content: body.content,
    targets,
    ownerships,
    publishAt: body.publish_at ? new Date(body.publish_at) : null,
  });

  if (!preflight.valid) {
    throw new ApiError('VALIDATION_FAILED', {
      message: 'One or more targets cannot be published as composed. Call preflight for detail.',
      details: preflight.targets
        .filter((t) => !t.valid)
        .flatMap((t) =>
          t.errors.map((e) => ({
            code: e.code,
            message: e.message,
            param: e.field ?? undefined,
            destination_id: t.destination_id,
            provider: t.provider,
          })),
        ),
    });
  }

  const requestHash = await sha256Hex(canonicalizeForHashing(body));
  const publishAt = body.publish_at ? new Date(body.publish_at) : null;

  // Fingerprints are computed before the transaction because hashing is async and a
  // transaction should not be held open across work that does not need the connection
  // (ADR-006 Layer 3).
  const fingerprints = new Map<string, string>();
  for (const target of targets) {
    const ownership = ownerships.get(target.destinationId)!;
    const overrides = target.overrides ?? {};
    fingerprints.set(
      target.destinationId,
      await sha256Hex(
        buildFingerprintInput({
          provider: ownership.provider,
          destinationId: target.destinationId,
          text: (overrides.text as string | undefined) ?? body.content.text,
          mediaIds: (overrides.media_ids as string[] | undefined) ?? body.content.media_ids,
          link: (overrides.link_url as string | undefined) ?? body.content.link_url ?? undefined,
          publishAt,
        }),
      ),
    );
  }

  const created = await c.get('db').transaction(async (tx) => {
    // Steps 4 and 8–11 of plan §24.1, in one transaction: either the key, the post and
    // every target exist, or none do. A post missing a target would silently never
    // publish to that destination, with nothing to indicate why.
    const { reserveIdempotency, completeReservation } = await import('@gs/db');

    const reservation = await reserveIdempotency(tx, {
      projectEnvironmentId: principal.projectEnvironmentId,
      projectId: principal.projectId,
      organizationId: principal.organizationId,
      key,
      requestHash,
      endpoint: 'POST /v1/posts',
      apiKeyId: principal.apiKeyId,
      requestId: trace.requestId,
      traceId: trace.traceId,
    });

    if (reservation.kind === 'replay') {
      return { replay: reservation.responseSnapshot } as const;
    }
    if (reservation.kind === 'in_progress') {
      throw new ApiError('IDEMPOTENCY_REQUEST_IN_PROGRESS', {
        message: 'An identical request is still being processed. Retry shortly.',
      });
    }
    if (reservation.kind === 'conflict') {
      throw new ApiError('IDEMPOTENCY_KEY_REUSED', {
        message: 'This Idempotency-Key was used with a different request body.',
      });
    }

    const result = await createPostWithTargets(tx, {
      profileId,
      projectEnvironmentId: principal.projectEnvironmentId,
      projectId: principal.projectId,
      organizationId: principal.organizationId,
      content: body.content,
      publishAt,
      allowDuplicate: body.allow_duplicate,
      status: publishAt ? 'scheduled' : 'queued',
      metadata: body.metadata,
      idempotencyKeyId: reservation.reservationId,
      createdByApiKeyId: principal.apiKeyId,
      requestId: trace.requestId,
      traceId: trace.traceId,
      targets: targets.map((target) => {
        const ownership = ownerships.get(target.destinationId)!;
        return {
          destinationId: target.destinationId,
          connectionId: ownership.connectionId,
          provider: ownership.provider,
          overrides: target.overrides,
          options: target.options,
          // ADR-006 Layer 3 — a stable hash of the resolved content, so a provider that
          // supports an idempotency key gets one, and reconciliation has something to
          // match a possible orphan against.
          contentFingerprint: fingerprints.get(target.destinationId) ?? null,
          status: publishAt ? 'scheduled' : 'queued',
        };
      }),
    });

    // The snapshot is the response body itself, so a replay is byte-identical to the
    // original rather than a re-derivation that could drift as the serializer changes.
    const snapshot = toPostResponse(result.post, result.targets, trace, mode);

    await completeReservation(tx, {
      reservationId: reservation.reservationId,
      resourceType: 'post',
      resourceId: result.post.id,
      responseStatus: '202',
      responseSnapshot: snapshot as unknown as Record<string, unknown>,
    });

    return { created: result, snapshot } as const;
  });

  if ('replay' in created) {
    // A previous identical request already created the post. Replaying its stored
    // response verbatim is what makes a client retry safe (P4).
    const snapshot = created.replay;
    if (snapshot) return c.json(snapshot, 202);
    throw new ApiError('IDEMPOTENCY_REQUEST_IN_PROGRESS', {
      message: 'An identical request completed but its response is unavailable. Fetch the post.',
    });
  }

  const response = created.snapshot;

  // Step 12 — hand off to the queue. Outside the transaction, because a queue send inside
  // one can succeed and then be rolled back, leaving a consumer to process a post that
  // does not exist.
  if (c.env.PUBLISH_QUEUE && !publishAt) {
    c.executionCtx.waitUntil(
      c.env.PUBLISH_QUEUE.sendBatch(
        created.created.targets.map((target) => ({
          body: {
            type: 'publish.target',
            postId: created.created.post.id,
            postTargetId: target.id,
            traceId: trace.traceId,
          },
        })),
      ),
    );
  }

  // Plan §15 — 202, never 200. The work has been accepted, not completed.
  return c.json(response, 202);
});

posts.get('/', withDatabase(), authenticate(['posts:read']), async (c) => {
  const principal = c.get('principal');
  const query = parseQuery(c, ListPostsQuerySchema);

  const cursor = query.cursor ? fromPublicId('post', query.cursor) : undefined;
  if (query.cursor && !cursor) {
    throw new ApiError('INVALID_REQUEST', { message: '`cursor` is not a valid post id.' });
  }

  let profileId: string | undefined;
  if (query.profile_id) {
    const resolved = fromPublicId('profile', query.profile_id);
    if (!resolved) {
      throw new ApiError('INVALID_REQUEST', { message: '`profile_id` is not a valid profile id.' });
    }
    profileId = resolved;
  }

  const { rows, hasMore } = await listPosts(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    limit: query.limit,
    order: query.order,
    cursor: cursor ?? undefined,
    profileId,
    status: query.status,
    restrictedToProfileId: principal.restrictedToProfileId,
  });

  const mode = environmentMode(c);
  const data = rows.map((row) => toPostSummary(row, mode));

  return c.json(
    PostListResponseSchema.parse({
      object: 'list',
      data,
      has_more: hasMore,
      next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
    }),
    200,
  );
});

/** Load a post with its targets, enforcing tenancy and key restriction. */
async function loadOwnedPost(c: Context<AppEnv>, postId: string) {
  const principal = c.get('principal');

  const found = await getPostWithTargets(c.get('db'), postId);
  if (
    !found ||
    found.post.projectEnvironmentId !== principal.projectEnvironmentId ||
    found.post.projectId !== principal.projectId ||
    found.post.organizationId !== principal.organizationId
  ) {
    throw new ApiError('POST_NOT_FOUND');
  }

  if (
    principal.restrictedToProfileId !== null &&
    principal.restrictedToProfileId !== found.post.profileId
  ) {
    throw new ApiError('TENANT_FORBIDDEN', {
      message: 'This API key is restricted to a different profile.',
    });
  }

  return found;
}

posts.get('/:postId', withDatabase(), authenticate(['posts:read']), async (c) => {
  const postId = requirePathId(c, 'post', 'postId');
  const { post, targets } = await loadOwnedPost(c, postId);
  return c.json(
    toPostResponse(post, targets, c.get('trace'), environmentMode(c)),
    200,
  );
});

posts.post('/:postId/cancel', withDatabase(), authenticate(['posts:write']), async (c) => {
  const postId = requirePathId(c, 'post', 'postId');
  const { post } = await loadOwnedPost(c, postId);

  // Published targets are not cancellable — the post is live on the platform, and
  // pretending otherwise would be a lie. Deleting it is a different operation.
  const cancelled = await cancelPostTargets(c.get('db'), { postId });

  // The aggregate has to be recomputed from its targets (plan §78). Without this the
  // post stays `queued` while every target reads `cancelled`, and the two disagree in
  // the response the caller is looking at.
  await recalculatePostStatus(c.get('db'), postId);
  const after = await getPostWithTargets(c.get('db'), postId);

  return c.json(
    CancelPostResponseSchema.parse({
      id: toPublicId('post', post.id),
      object: 'post',
      status: after?.post.status ?? post.status,
      cancelled_targets: cancelled.length,
    }),
    200,
  );
});

posts.post('/:postId/retry', withDatabase(), authenticate(['posts:write']), async (c) => {
  const postId = requirePathId(c, 'post', 'postId');
  const trace = c.get('trace');
  const { post } = await loadOwnedPost(c, postId);

  // Only `retryable_failed` targets are requeued. A `permanent_failed` target will fail
  // the same way, and an `unknown_reconciliation_required` one must be reconciled first —
  // retrying it could duplicate a post that did publish (ADR-006 Layer 4).
  // retryableOnly: a permanent failure fails the same way again, and an
  // unknown_reconciliation_required target must be reconciled first — retrying it could
  // duplicate a post that did publish (ADR-006 Layer 4).
  const requeued = await requeueFailedTargets(c.get('db'), { postId, retryableOnly: true });

  // A post that was `failed` becomes `queued` again once its targets are requeued.
  await recalculatePostStatus(c.get('db'), postId);
  const after = await getPostWithTargets(c.get('db'), postId);

  if (requeued.length > 0 && c.env.PUBLISH_QUEUE) {
    c.executionCtx.waitUntil(
      c.env.PUBLISH_QUEUE.sendBatch(
        requeued.map((target) => ({
          body: { type: 'publish.target', postId, postTargetId: target.id, traceId: trace.traceId },
        })),
      ),
    );
  }

  return c.json(
    RetryPostResponseSchema.parse({
      id: toPublicId('post', post.id),
      object: 'post',
      status: after?.post.status ?? post.status,
      requeued_targets: requeued.length,
    }),
    202,
  );
});

/**
 * Retry one target (plan §14).
 *
 * Separate from retrying the whole post because a partially-published post is the normal
 * case, not the exception (plan §26): four targets succeeded, LinkedIn failed, and the
 * caller wants LinkedIn retried without touching anything that already went out. Retrying
 * the post would be safe — published targets are not requeued — but it says the wrong
 * thing, and it gives the caller no way to act on one destination.
 */
posts.post(
  '/:postId/targets/:targetId/retry',
  withDatabase(),
  authenticate(['posts:write']),
  async (c) => {
    const postId = requirePathId(c, 'post', 'postId');
    const targetId = requirePathId(c, 'postTarget', 'targetId');
    const trace = c.get('trace');

    const { targets } = await loadOwnedPost(c, postId);

    // Ownership of the target follows from ownership of the post, but the target must
    // still belong to *this* post — a valid target id from another post would otherwise
    // requeue something the caller never named.
    const target = targets.find((row) => row.id === targetId);
    if (!target) throw new ApiError('TARGET_NOT_FOUND');

    const requeued = await requeueTarget(c.get('db'), { postId, targetId });
    if (!requeued) {
      throw new ApiError('TARGET_NOT_RETRYABLE', {
        message:
          target.status === 'unknown_reconciliation_required'
            ? 'This target is being reconciled. Retrying before the outcome is known could publish it twice.'
            : `A target in state "${target.status}" cannot be retried.`,
      });
    }

    await recalculatePostStatus(c.get('db'), postId);
    const after = await getPostWithTargets(c.get('db'), postId);

    if (c.env.PUBLISH_QUEUE) {
      c.executionCtx.waitUntil(
        c.env.PUBLISH_QUEUE.send({
          type: 'publish.target',
          postId,
          postTargetId: targetId,
          traceId: trace.traceId,
        }),
      );
    }

    return c.json(
      RetryTargetResponseSchema.parse({
        id: toPublicId('postTarget', targetId),
        object: 'post_target',
        status: requeued.status,
        post_status: after?.post.status ?? 'queued',
        requeued: true,
      }),
      202,
    );
  },
);

/**
 * Post timeline (plan §40).
 *
 * Everything that happened to a post and its targets, in one ordered list. Plan §40 calls
 * this "extremely valuable to developers", and the reason is that the alternative is
 * reading three tables through two endpoints and reconstructing the ordering by hand.
 */
posts.get('/:postId/timeline', withDatabase(), authenticate(['posts:read']), async (c) => {
  const postId = requirePathId(c, 'post', 'postId');
  const { post, targets } = await loadOwnedPost(c, postId);

  const attempts = await listPostAttempts(c.get('db'), postId);

  return c.json(
    PostTimelineResponseSchema.parse({
      object: 'post_timeline',
      post_id: toPublicId('post', post.id),
      status: post.status,
      events: buildPostTimeline(post, targets, attempts),
    }),
    200,
  );
});

/** Re-exported so the serializer module can validate provider names consistently. */
export { isProviderName };
