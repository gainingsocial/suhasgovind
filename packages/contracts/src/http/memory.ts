import { z } from 'zod';

import { ProviderNameSchema } from '../common/providers.js';

/**
 * Social memory and the optimization loop (plan Phase 10).
 *
 * Every performance response carries `sample_size` and `confidence`, and neither is
 * optional. A recommendation a customer cannot audit is one they are right not to trust,
 * and the difference between "video works better for you" and "video averaged 1.6× your
 * engagement rate over 42 posts" is the difference between a horoscope and a finding.
 *
 * Nothing below the minimum sample size is returned at all — not flagged, not greyed out.
 * A finding nobody should act on should not be in the response.
 */

export const BrandMemoryKindSchema = z.enum([
  'product',
  'audience',
  'competitor',
  'vocabulary',
  'campaign',
  'faq',
  'banned_claim',
]);

export const BrandMemoryEntrySchema = z
  .object({
    id: z.string(),
    object: z.literal('brand_memory_entry'),
    kind: BrandMemoryKindSchema,
    label: z.string(),
    body: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict();

export const UpsertBrandMemoryRequestSchema = z
  .object({
    kind: BrandMemoryKindSchema,
    /** Matched case-insensitively, so re-sending a label edits the fact rather than adding one. */
    label: z.string().min(1).max(200),
    body: z.string().max(8000).nullish(),
    metadata: z.record(z.string().max(64), z.unknown()).default({}),
  })
  .strict();

export const BrandMemoryListResponseSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(BrandMemoryEntrySchema),
    has_more: z.literal(false),
    next_cursor: z.null(),
  })
  .strict();

export const DeleteBrandMemoryResponseSchema = z
  .object({
    id: z.string(),
    object: z.literal('brand_memory_entry'),
    deleted: z.literal(true),
  })
  .strict();

export const PerformanceDimensionSchema = z.enum(['format', 'posting_hour', 'posting_weekday']);

export const PerformanceObservationSchema = z
  .object({
    object: z.literal('performance_observation'),
    provider: ProviderNameSchema,
    dimension: PerformanceDimensionSchema,
    bucket: z.string(),
    /** Published posts behind this. Never below the minimum, always shown. */
    sample_size: z.number().int(),
    bucket_mean: z.number(),
    /** This profile's own mean on this network — never a global or industry figure. */
    baseline_mean: z.number(),
    /** `bucket_mean / baseline_mean`. 1.0 is indistinguishable from the average. */
    lift: z.number(),
    /**
     * `engagement_rate` when impressions were known for every sample, `engagements`
     * otherwise. A rate and a count are not comparable, and a reader has to know which.
     */
    metric: z.enum(['engagement_rate', 'engagements']),
    /** From sample size alone. Nothing here claims significance it has not tested for. */
    confidence: z.enum(['low', 'medium', 'high']),
    window_start: z.iso.datetime(),
    window_end: z.iso.datetime(),
    computed_at: z.iso.datetime(),
  })
  .strict();

export const PerformanceListResponseSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(PerformanceObservationSchema),
    has_more: z.literal(false),
    next_cursor: z.null(),
  })
  .strict();

export const LearnRequestSchema = z
  .object({
    profile_id: z.string(),
    /** How far back to learn from. Older content reflects an audience that has moved on. */
    days: z.number().int().min(7).max(365).default(90),
  })
  .strict();

export const LearnResponseSchema = z
  .object({
    object: z.literal('learn_result'),
    profile_id: z.string(),
    /** Published posts that were old enough to count. */
    samples_considered: z.number().int(),
    observations_written: z.number().int(),
    window_start: z.iso.datetime(),
    window_end: z.iso.datetime(),
  })
  .strict();

export const RecommendationSchema = z
  .object({
    object: z.literal('recommendation'),
    /** Stable. Branch on this rather than on the sentence. */
    code: z.enum([
      'prefer_format',
      'avoid_format',
      'prefer_posting_hour',
      'prefer_posting_weekday',
    ]),
    provider: ProviderNameSchema,
    dimension: PerformanceDimensionSchema,
    bucket: z.string(),
    /** Plain language, and it always names its own evidence. */
    statement: z.string(),
    lift: z.number(),
    sample_size: z.number().int(),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();

export const RecommendationListResponseSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(RecommendationSchema),
    has_more: z.literal(false),
    next_cursor: z.null(),
    /**
     * Why the list is empty, when it is.
     *
     * An empty recommendations array has two very different causes — nothing has been
     * learned yet, or everything learned was unremarkable — and a client showing "no
     * recommendations" for the first case is telling a new customer their content is
     * average when in truth nobody has measured it.
     */
    reason: z.enum(['ok', 'not_enough_data', 'nothing_notable']),
  })
  .strict();

export type BrandMemoryEntryShape = z.infer<typeof BrandMemoryEntrySchema>;
export type RecommendationShape = z.infer<typeof RecommendationSchema>;
