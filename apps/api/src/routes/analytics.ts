import {
  AnalyticsSummaryResponseSchema,
  ExternalPostListResponseSchema,
  ExternalPostSchema,
} from '@gs/contracts/http';
import { fromPublicId, toPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import {
  findLatestSnapshot,
  listExternalPosts,
  summarizeProfileAnalytics,
  type AnalyticsSnapshot,
  type ExternalPost,
} from '@gs/db';
import { engagementRate } from '@gs/domain';
import { ApiError } from '@gs/errors';
import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';

/**
 * Analytics (plan Phase 6).
 *
 * Reads stored observations only. Plan Phase 6 forbids querying a provider live for a
 * dashboard load, and the arithmetic is why: a customer with forty connected accounts
 * opening an overview would fire forty provider calls, exhaust a rate limit publishing also
 * depends on, and take twelve seconds to render a number that was fine an hour ago.
 *
 * Every response carries its freshness. Never implying analytics is real-time is the other
 * half of Phase 6, and it is the half that decides whether a customer trusts the numbers.
 */
export const analytics = new Hono<AppEnv>();

const PAGE_SIZE = 50;

function toMetrics(snapshot: AnalyticsSnapshot | null) {
  if (!snapshot) return null;

  const values = {
    impressions: snapshot.impressions,
    reach: snapshot.reach,
    views: snapshot.views,
    likes: snapshot.likes,
    comments: snapshot.comments,
    shares: snapshot.shares,
    saves: snapshot.saves,
    clicks: snapshot.clicks,
    engagements: snapshot.engagements,
    watch_time_seconds: snapshot.watchTimeSeconds,
    followers_delta: snapshot.followersDelta,
  };

  return {
    ...values,
    engagement_rate: engagementRate({
      engagements: values.engagements ?? undefined,
      likes: values.likes ?? undefined,
      comments: values.comments ?? undefined,
      shares: values.shares ?? undefined,
      saves: values.saves ?? undefined,
      clicks: values.clicks ?? undefined,
      reach: values.reach ?? undefined,
      impressions: values.impressions ?? undefined,
    }),
  };
}

function toResponse(post: ExternalPost, snapshot: AnalyticsSnapshot | null) {
  return ExternalPostSchema.parse({
    id: toPublicId('post', post.id),
    object: 'external_post',
    provider: isProviderName(post.provider) ? post.provider : 'mock',
    destination_id: toPublicId('destination', post.destinationId),
    external_post_id: post.externalPostId,
    external_url: post.externalUrl,
    post_id: post.postId ? toPublicId('post', post.postId) : null,
    post_type: post.postType,
    excerpt: post.excerpt,
    // Rule 15 — the provider's own timestamp, in UTC.
    published_at: post.publishedAt?.toISOString() ?? null,
    metrics: toMetrics(snapshot),
    freshness: {
      observed_at: snapshot?.observedAt.toISOString() ?? null,
      provider_data_as_of: snapshot?.providerDataAsOf?.toISOString() ?? null,
      next_expected_refresh: snapshot?.nextExpectedRefresh?.toISOString() ?? null,
    },
  });
}

analytics.get('/posts', withDatabase(), authenticate(['analytics:read']), async (c) => {
  const principal = c.get('principal');

  let profileId: string | undefined;
  const requestedProfile = c.req.query('profile_id');
  if (requestedProfile) {
    const resolved = fromPublicId('profile', requestedProfile);
    if (!resolved) {
      throw new ApiError('INVALID_REQUEST', {
        message: '`profile_id` is not a valid profile id.',
        param: 'profile_id',
      });
    }
    profileId = resolved;
  }

  // Enforced regardless of what was asked for: a profile-restricted key sees one profile
  // whether or not it names one (plan §38).
  if (principal.restrictedToProfileId) profileId = principal.restrictedToProfileId;

  const rows = await listExternalPosts(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId,
    provider: c.req.query('provider') ?? null,
    limit: PAGE_SIZE + 1,
  });

  const page = rows.slice(0, PAGE_SIZE);

  /**
   * One snapshot lookup per post.
   *
   * Bounded by the page size and each is an indexed lookup on
   * `(external_post_id, observed_at desc)`. Denormalizing the latest values onto the post
   * would remove them, but then a snapshot arriving would have two places to write and the
   * two would eventually disagree — and a disagreement here is a customer seeing different
   * numbers on two screens.
   */
  const data = await Promise.all(
    page.map(async (post) => toResponse(post, await findLatestSnapshot(c.get('db'), post.id))),
  );

  return c.json(
    ExternalPostListResponseSchema.parse({
      object: 'list',
      data,
      has_more: rows.length > PAGE_SIZE,
      next_cursor: null,
    }),
    200,
  );
});

analytics.get('/summary', withDatabase(), authenticate(['analytics:read']), async (c) => {
  const principal = c.get('principal');

  let profileId: string | null = principal.restrictedToProfileId;
  const requestedProfile = c.req.query('profile_id');

  if (!profileId && requestedProfile) {
    profileId = fromPublicId('profile', requestedProfile);
    if (!profileId) {
      throw new ApiError('INVALID_REQUEST', {
        message: '`profile_id` is not a valid profile id.',
        param: 'profile_id',
      });
    }
  }

  const totals = await summarizeProfileAnalytics(c.get('db'), {
    projectEnvironmentId: principal.projectEnvironmentId,
    profileId,
  });

  return c.json(
    AnalyticsSummaryResponseSchema.parse({
      object: 'analytics_summary',
      posts: totals.posts,
      impressions: totals.impressions,
      reach: totals.reach,
      engagements: totals.engagements,
      engagement_rate: engagementRate({
        engagements: totals.engagements ?? undefined,
        reach: totals.reach ?? undefined,
        impressions: totals.impressions ?? undefined,
      }),
    }),
    200,
  );
});
