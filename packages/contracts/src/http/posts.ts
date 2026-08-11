import { z } from 'zod';

import { listResponseSchema, PaginationQuerySchema } from '../common/pagination.js';
import { ProviderNameSchema } from '../common/providers.js';
import { TargetValidationResultSchema } from '../providers/validation.js';

/**
 * Post contracts (plan §11, §14, §15).
 *
 * One logical post, N publish targets (P2). The customer describes what they want said;
 * the engine resolves what each platform actually receives.
 */

/** Plan §12.1. */
export const PostStatusSchema = z.enum([
  'draft',
  'validating',
  'awaiting_approval',
  'scheduled',
  'queued',
  'publishing',
  'published',
  /** Some targets succeeded and some did not. A first-class outcome (plan §26). */
  'partially_published',
  'failed',
  'cancelled',
]);

/** Plan §12.2. */
export const PostTargetStatusSchema = z.enum([
  'pending',
  'blocked_validation',
  'awaiting_approval',
  'scheduled',
  'queued',
  'preparing_media',
  'publishing',
  /** Accepted by the provider, still transcoding. Not yet live. */
  'provider_processing',
  'published',
  'retryable_failed',
  'permanent_failed',
  'cancelled',
  /**
   * The outcome is genuinely unknown — typically an ambiguous timeout. Never retried
   * without reconciliation first (ADR-006 Layer 4), because a blind retry could duplicate
   * a post that did in fact publish.
   */
  'unknown_reconciliation_required',
]);

const MAX_TEXT_LENGTH = 50_000;
const MAX_MEDIA_PER_POST = 20;
const MAX_TARGETS_PER_POST = 50;

export const PostContentSchema = z
  .object({
    text: z.string().max(MAX_TEXT_LENGTH).default(''),
    /**
     * Ordered — carousel order is the array order. Must be `ready`; media still being
     * probed is rejected rather than silently waited on, because the caller needs to know
     * their upload is not finished.
     */
    media_ids: z.array(z.string()).max(MAX_MEDIA_PER_POST).default([]),
    link_url: z.url().nullish(),
  })
  .strict();

/**
 * Per-target overrides (plan §11.2).
 *
 * Resolution order is canonical content → target override → provider options → provider
 * defaults. An absent override inherits; it does not blank the field.
 */
export const TargetOverridesSchema = z
  .object({
    text: z.string().max(MAX_TEXT_LENGTH).optional(),
    media_ids: z.array(z.string()).max(MAX_MEDIA_PER_POST).optional(),
    link_url: z.url().nullish(),
  })
  .strict();

/**
 * Provider-native escape hatch (plan §43, §11.3).
 *
 * Keyed by provider so options cannot be applied to the wrong platform. The values stay
 * loosely typed at this layer and are validated by the owning adapter, which is the only
 * thing that knows what its platform accepts — validating them here would put
 * provider-specific knowledge in the core and violate P1.
 */
export const ProviderOptionsSchema = z.record(ProviderNameSchema, z.record(z.string(), z.unknown()));

export const PostTargetRequestSchema = z
  .object({
    destination_id: z.string(),
    overrides: TargetOverridesSchema.optional(),
    options: ProviderOptionsSchema.optional(),
  })
  .strict();

export const CreatePostRequestSchema = z
  .object({
    profile_id: z.string(),
    content: PostContentSchema,
    targets: z.array(PostTargetRequestSchema).min(1).max(MAX_TARGETS_PER_POST),
    /** UTC ISO-8601. Null or absent publishes immediately (Rule 15). */
    publish_at: z.iso.datetime().nullish(),
    /**
     * Bypasses the content-fingerprint duplicate check (ADR-006 Layer 3). Needed for
     * genuinely repeated content — a daily "we're open" post — and off by default,
     * because the common case is an accidental double submit.
     */
    allow_duplicate: z.boolean().default(false),
    metadata: z.record(z.string().max(64), z.unknown()).default({}),
  })
  .strict();

export type CreatePostRequest = z.infer<typeof CreatePostRequestSchema>;

export const PostTargetSchema = z.object({
  id: z.string(),
  object: z.literal('post_target'),
  destination_id: z.string(),
  provider: ProviderNameSchema,
  status: PostTargetStatusSchema,
  /** The provider's own id for the published post. Null until it exists. */
  external_post_id: z.string().nullable(),
  external_url: z.string().nullable(),
  published_at: z.iso.datetime().nullable(),
  attempt_count: z.number().int(),
  /** Normalized failure code (plan §79), not the provider's own string. */
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  /** UTC ISO-8601. Set when a retry is scheduled. */
  next_attempt_at: z.iso.datetime().nullable(),
});

export const PostSchema = z.object({
  id: z.string(),
  object: z.literal('post'),
  status: PostStatusSchema,
  profile_id: z.string(),
  content: PostContentSchema,
  publish_at: z.iso.datetime().nullable(),
  targets: z.array(PostTargetSchema),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /** Echoed so a caller can correlate a 202 with their logs without parsing headers. */
  request_id: z.string(),
  trace_id: z.string(),
});

export type Post = z.infer<typeof PostSchema>;

export const ListPostsQuerySchema = PaginationQuerySchema.extend({
  profile_id: z.string().optional(),
  status: PostStatusSchema.optional(),
});

export const PostListResponseSchema = listResponseSchema(
  // The list omits per-target detail. A page of 25 posts each with 10 targets is a large
  // response nobody reads in full; the detail endpoint has it.
  PostSchema.omit({ targets: true }).extend({
    target_count: z.number().int(),
    /** Rolled up so a list view can show progress without fetching each post. */
    published_target_count: z.number().int(),
  }),
);

/**
 * Preflight (plan §18).
 *
 * Takes the same body as `POST /v1/posts` deliberately — a caller must be able to check
 * exactly what they are about to send, not an approximation of it.
 */
export const PreflightRequestSchema = CreatePostRequestSchema;

export const PreflightResponseSchema = z.object({
  object: z.literal('preflight'),
  /** True only when every target is valid. */
  valid: z.boolean(),
  targets: z.array(TargetValidationResultSchema),
});

export const CancelPostResponseSchema = z.object({
  id: z.string(),
  object: z.literal('post'),
  status: PostStatusSchema,
  /** How many targets were still cancellable. Already-published ones are not. */
  cancelled_targets: z.number().int(),
});

export const RetryPostResponseSchema = z.object({
  id: z.string(),
  object: z.literal('post'),
  status: PostStatusSchema,
  requeued_targets: z.number().int(),
});

export const RetryTargetResponseSchema = z.object({
  id: z.string(),
  object: z.literal('post_target'),
  status: PostTargetStatusSchema,
  /** The post's rolled-up status after the target was requeued (plan §78). */
  post_status: PostStatusSchema,
  requeued: z.literal(true),
});

/**
 * Post timeline (plan §40).
 *
 * Every state change for a post and its targets, in order, as one list. Plan §40 calls
 * this "extremely valuable to developers" and it is: the alternative to a timeline is an
 * integrator reading four tables through three endpoints and reconstructing the ordering
 * themselves, which is precisely the work an observability surface exists to remove.
 */
export const TimelineEventSchema = z.object({
  at: z.iso.datetime(),
  /**
   * `post.accepted`, `target.queued`, `target.publishing`, `target.published`,
   * `target.failed`, `target.reconciliation_required`, `post.published`, … Stable strings,
   * safe to branch on.
   */
  type: z.string(),
  /** One line, written to be read by a human scanning for what went wrong. */
  message: z.string(),
  /** Present for target-scoped entries. */
  target_id: z.string().nullable(),
  provider: ProviderNameSchema.nullable(),
  /** Normalized failure code (plan §79) when this entry records a failure. */
  error_code: z.string().nullable(),
  /** Attempt number for entries produced by a publish attempt. */
  attempt: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
});

export const PostTimelineResponseSchema = z.object({
  object: z.literal('post_timeline'),
  post_id: z.string(),
  status: PostStatusSchema,
  events: z.array(TimelineEventSchema),
});
