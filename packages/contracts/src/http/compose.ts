import { z } from 'zod';

import { ProviderNameSchema } from '../common/providers.js';
import { FitDecisionSchema, PostMediaFitSchema } from '../providers/validation.js';
import { PostContentSchema } from './posts.js';

/**
 * The Smart Universal Composer (plan §63B, §63C).
 *
 * > Upload once. Write once. Select networks. We prepare everything else.
 *
 * One call takes canonical content plus a set of destinations and answers, per network:
 * what will actually be published, what we changed to get there, and what still needs a
 * person. It is the endpoint behind Creator Studio, and it is deliberately available to
 * API callers and agents too — the dashboard is an API client (P11/P15), so anything it
 * can do must be reachable without it.
 *
 * Composing does not publish. The result is a preview and a plan; `POST /v1/posts` remains
 * the only thing that publishes, and it is called with the per-target overrides this
 * returns.
 */

export const ComposeModeSchema = z.enum(['exact', 'optimize']);

export const ComposeRequestSchema = z.object({
  profile_id: z.string(),
  content: PostContentSchema,
  /** The destinations to prepare for. Same shape as `POST /v1/posts`. */
  targets: z
    .array(z.object({ destination_id: z.string() }).strict())
    .min(1)
    .max(50),
  /**
   * `exact` preserves the writing and reports every problem for the author to resolve.
   * `optimize` additionally applies the mechanical fixes — moving a trailing hashtag block,
   * shortening at a sentence boundary — and reports each one.
   *
   * Neither mode rewrites or rephrases. That is a model call the author reviews
   * (plan §63R), not something a publish does quietly.
   */
  mode: ComposeModeSchema.default('optimize'),
});

export const TextAdaptationSchema = z
  .object({
    kind: z.enum(['truncate', 'move_hashtags', 'strip_link', 'strip_mentions']),
    decision: FitDecisionSchema,
    reason: z.string(),
  })
  .strict();

/** What one destination would actually receive. */
export const ComposedTargetSchema = z
  .object({
    destination_id: z.string(),
    provider: ProviderNameSchema,
    destination_name: z.string(),
    /**
     * Overall readiness, in the composer's own vocabulary rather than a bare boolean.
     * `ready` publishes untouched; `adapted` publishes after changes we can make; the rest
     * need somebody.
     */
    status: z.enum(['ready', 'adapted', 'needs_review', 'needs_decision', 'blocked']),
    /** One sentence, plain language, for the top of a card (plan §63C). */
    summary: z.string(),
    /** Exactly what would be published, after any adaptation. */
    preview: z
      .object({
        text: z.string(),
        /** Hashtags lifted out of the body, for a first comment where supported. */
        first_comment_hashtags: z.array(z.string()).readonly(),
        media_ids: z.array(z.string()).readonly(),
        link_url: z.string().nullable(),
      })
      .strict(),
    text_adaptations: z.array(TextAdaptationSchema).readonly(),
    media_fit: PostMediaFitSchema.nullable(),
    /** Blocking problems, in the same shape preflight uses. */
    errors: z
      .array(z.object({ code: z.string(), message: z.string(), agent_action: z.string() }).strict())
      .readonly(),
    warnings: z
      .array(z.object({ code: z.string(), message: z.string(), agent_action: z.string() }).strict())
      .readonly(),
    /**
     * The `targets[]` entry to send to `POST /v1/posts` to publish exactly this preview.
     * Supplied so a caller never has to reconstruct the adaptation themselves and risk
     * publishing something subtly different from what was shown.
     */
    publish_override: z.record(z.string(), z.unknown()),
  })
  .strict();

export const ComposeResponseSchema = z
  .object({
    object: z.literal('composition'),
    mode: ComposeModeSchema,
    /** True when every target could publish without further input. */
    ready: z.boolean(),
    /** The consolidated line a person reads first (plan §63C). */
    summary: z.string(),
    targets: z.array(ComposedTargetSchema).readonly(),
  })
  .strict();

export type ComposeRequest = z.infer<typeof ComposeRequestSchema>;
export type ComposeResponse = z.infer<typeof ComposeResponseSchema>;
export type ComposedTarget = z.infer<typeof ComposedTargetSchema>;
