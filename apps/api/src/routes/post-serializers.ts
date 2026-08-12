import { PostSchema, type PostListResponseSchema, type Post as PostResponse } from '@gs/contracts/http';
import { toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import type { Post, PostTarget } from '@gs/db';
import { ApiError } from '@gs/errors';
import type { TraceContext } from '@gs/observability';

/**
 * Row → public representation for posts.
 *
 * Separated from the route module so the create, read and list paths cannot drift into
 * three slightly different shapes of the same object — which is how a client ends up
 * needing to know which endpoint returned a post before it can parse it.
 */

type PostSummary = (typeof PostListResponseSchema)['shape']['data']['element']['_output'];

function requireProvider(row: { id: string; provider: string }): string {
  if (!isProviderName(row.provider)) {
    // A row naming a provider this build does not know is a data fault. Reporting it
    // precisely beats emitting an object that fails its own output schema (Rule 14).
    throw new ApiError('INTERNAL_ERROR', {
      message: `Target ${row.id} names unknown provider "${row.provider}".`,
    });
  }
  return row.provider;
}

export function toPostResponse(
  post: Post,
  targets: readonly PostTarget[],
  trace: TraceContext,
  /**
   * How the environment executes (plan §49).
   *
   * Passed in rather than derived from the targets, because a post that has not been
   * executed yet has no simulated targets to derive it from — and `mode` is exactly what
   * a caller reads on the 202 to know whether anything is about to leave the building.
   */
  mode: 'live' | 'simulate' = 'live',
): PostResponse {
  return PostSchema.parse({
    id: toPublicId('post', post.id),
    object: 'post',
    status: post.status,
    profile_id: toPublicId('profile', post.profileId),
    content: post.content,
    // Rule 15 — every public timestamp is UTC ISO-8601.
    publish_at: post.publishAt?.toISOString() ?? null,
    targets: targets.map((target) => ({
      id: toPublicId('postTarget', target.id),
      object: 'post_target',
      destination_id: toPublicId('destination', target.destinationId),
      provider: requireProvider(target),
      status: target.status,
      external_post_id: target.providerPostId,
      external_url: target.providerPostUrl,
      published_at: target.publishedAt?.toISOString() ?? null,
      attempt_count: target.attemptCount,
      // The normalized code (plan §79), never the provider's own string — clients branch
      // on this, and a provider changing its wording must not break them.
      error_code: target.errorCode,
      error_message: target.errorMessage,
      next_attempt_at: target.nextAttemptAt?.toISOString() ?? null,
      simulated: target.simulated,
    })),
    metadata: post.metadata,
    mode,
    created_at: post.createdAt.toISOString(),
    updated_at: post.updatedAt.toISOString(),
    request_id: trace.requestId,
    trace_id: trace.traceId,
  });
}

export interface PostListRow {
  post: Post;
  targetCount: number;
  publishedTargetCount: number;
}

/**
 * List rows omit per-target detail.
 *
 * A page of 25 posts each with 10 targets is a large response nobody reads in full. The
 * rolled-up counts are enough for a list view to show progress, and the detail endpoint
 * has the rest.
 */
export function toPostSummary(row: PostListRow, mode: 'live' | 'simulate' = 'live'): PostSummary {
  return {
    mode,
    id: toPublicId('post', row.post.id),
    object: 'post' as const,
    status: row.post.status,
    profile_id: toPublicId('profile', row.post.profileId),
    content: row.post.content as PostSummary['content'],
    publish_at: row.post.publishAt?.toISOString() ?? null,
    metadata: row.post.metadata,
    created_at: row.post.createdAt.toISOString(),
    updated_at: row.post.updatedAt.toISOString(),
    request_id: row.post.requestId ?? '',
    trace_id: row.post.traceId ?? '',
    target_count: row.targetCount,
    published_target_count: row.publishedTargetCount,
  };
}
