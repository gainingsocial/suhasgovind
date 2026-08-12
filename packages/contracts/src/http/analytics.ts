import { z } from 'zod';

import { ProviderNameSchema } from '../common/providers.js';

/**
 * Analytics (plan Phase 6).
 *
 * Every figure is a stored observation, never a live provider call. The three timestamps
 * below are deliberately separate: collapsing them is how a customer concludes their post
 * got no engagement when in truth nobody has looked yet.
 */
export const AnalyticsMetricsSchema = z
  .object({
    impressions: z.number().int().nullable(),
    reach: z.number().int().nullable(),
    views: z.number().int().nullable(),
    likes: z.number().int().nullable(),
    comments: z.number().int().nullable(),
    shares: z.number().int().nullable(),
    saves: z.number().int().nullable(),
    clicks: z.number().int().nullable(),
    engagements: z.number().int().nullable(),
    watch_time_seconds: z.number().int().nullable(),
    followers_delta: z.number().int().nullable(),
    /**
     * Engagements divided by reach, or by impressions when reach is unavailable.
     * `null` when there is no denominator — 0% and "cannot be computed" mean opposite
     * things and must not look identical.
     */
    engagement_rate: z.number().nullable(),
  })
  .strict();

export const AnalyticsFreshnessSchema = z
  .object({
    /** When we asked the provider. */
    observed_at: z.iso.datetime().nullable(),
    /** What the provider said the numbers were current as of — usually hours earlier. */
    provider_data_as_of: z.iso.datetime().nullable(),
    /** When we will ask again. */
    next_expected_refresh: z.iso.datetime().nullable(),
  })
  .strict();

export const ExternalPostSchema = z
  .object({
    id: z.string(),
    object: z.literal('external_post'),
    provider: ProviderNameSchema,
    destination_id: z.string(),
    /** The provider's own id for the post. */
    external_post_id: z.string(),
    external_url: z.string().nullable(),
    /**
     * Set when this system published it. `null` means it was posted another way — a normal
     * permanent state, not missing data.
     */
    post_id: z.string().nullable(),
    post_type: z.string().nullable(),
    excerpt: z.string().nullable(),
    published_at: z.iso.datetime().nullable(),
    metrics: AnalyticsMetricsSchema.nullable(),
    freshness: AnalyticsFreshnessSchema,
  })
  .strict();

export const ExternalPostListResponseSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(ExternalPostSchema),
    has_more: z.boolean(),
    next_cursor: z.null(),
  })
  .strict();

export const AnalyticsSummaryResponseSchema = z
  .object({
    object: z.literal('analytics_summary'),
    /** Posts with at least one observation. */
    posts: z.number().int(),
    /** `null` rather than 0 when nothing has been observed yet. */
    impressions: z.number().int().nullable(),
    reach: z.number().int().nullable(),
    engagements: z.number().int().nullable(),
    engagement_rate: z.number().nullable(),
  })
  .strict();

export type ExternalPostResponse = z.infer<typeof ExternalPostSchema>;
