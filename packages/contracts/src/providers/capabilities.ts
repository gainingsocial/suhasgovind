import { z } from 'zod';

import { ProviderNameSchema } from '../common/providers.js';

/**
 * Capability registry (plan §17).
 *
 * A product feature, not documentation. Agents call this to decide what is even possible
 * before composing a post, which is what stops the "compose, submit, get rejected, guess"
 * loop that plan P16/P17 exist to eliminate.
 *
 * Two resolutions, and the difference matters (plan §17):
 *
 *   generic    `GET /v1/platforms/{provider}/capabilities`
 *              what the platform can do at all
 *   effective  `GET /v1/destinations/{id}/capabilities`
 *              what THIS connected destination can do, narrowed by granted scopes,
 *              account type (personal vs business/creator), subscription, provider
 *              approval state, region and rollout
 *
 * Effective capability is never inferred client-side by intersecting generic capability
 * with a guess about the account. The adapter resolves it, because only the adapter knows
 * that (for example) an unaudited TikTok client cannot post publicly at all.
 */

/**
 * Schema version (plan §80).
 *
 * Persisted alongside every cached capability document. A consumer that reads a cached
 * document written under an older version must re-resolve rather than misinterpret it —
 * capability shape changes are the kind of thing that silently produces wrong preflight
 * answers otherwise.
 */
export const CAPABILITY_SCHEMA_VERSION = 1;

export const MediaKindSchema = z.enum(['image', 'video', 'audio', 'document']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

/** What kinds of post this destination can create. */
export const PublishingCapabilitiesSchema = z
  .object({
    text_only: z.boolean(),
    image: z.boolean(),
    video: z.boolean(),
    carousel: z.boolean(),
    story: z.boolean(),
    reel: z.boolean(),
    link_preview: z.boolean(),
    poll: z.boolean(),
    /** Publishing at a provider-scheduled future time, as opposed to us holding it. */
    native_scheduling: z.boolean(),
    /** Whether a thread/multi-part post is supported natively. */
    thread: z.boolean(),
  })
  .strict();

export type PublishingCapabilities = z.infer<typeof PublishingCapabilitiesSchema>;

/** Post-publish actions. Drives which endpoints are offered for a destination. */
export const ActionCapabilitiesSchema = z
  .object({
    delete_post: z.boolean(),
    edit_post: z.boolean(),
    comments_read: z.boolean(),
    comments_reply: z.boolean(),
    dm_send: z.boolean(),
    analytics_read: z.boolean(),
  })
  .strict();

export type ActionCapabilities = z.infer<typeof ActionCapabilitiesSchema>;

/** Numeric and enumerated limits. `null` means "no limit the provider documents". */
export const CapabilityConstraintsSchema = z
  .object({
    max_text_length: z.number().int().positive().nullable(),
    max_media_count: z.number().int().positive().nullable(),
    max_image_bytes: z.number().int().positive().nullable(),
    max_video_bytes: z.number().int().positive().nullable(),
    max_video_duration_seconds: z.number().int().positive().nullable(),
    min_video_duration_seconds: z.number().int().positive().nullable(),
    supported_image_types: z.array(z.string()).readonly(),
    supported_video_types: z.array(z.string()).readonly(),
    /** Aspect ratios as `width:height`, e.g. `["1:1", "4:5", "16:9"]`. Empty means unconstrained. */
    supported_aspect_ratios: z.array(z.string()).readonly(),
    max_hashtags: z.number().int().nonnegative().nullable(),
    max_mentions: z.number().int().nonnegative().nullable(),
    /** Privacy levels the destination accepts, if it requires an explicit choice. */
    allowed_privacy_levels: z.array(z.string()).readonly(),
    /** Whether alt text can be supplied per media item. */
    supports_alt_text: z.boolean(),
  })
  .strict();

export type CapabilityConstraints = z.infer<typeof CapabilityConstraintsSchema>;

/**
 * Why a capability is unavailable when the platform itself supports it.
 *
 * Without this, an agent that sees `video: false` for Instagram cannot tell whether
 * Instagram lacks video or whether this particular connection is missing a scope. The
 * remediation is completely different, so the distinction is part of the contract
 * (plan §48.4 structured remediation).
 */
export const CapabilityRestrictionSchema = z
  .object({
    capability: z.string().describe('Dotted path, e.g. `publishing.video`.'),
    reason: z.enum([
      'scope_missing',
      'account_type_ineligible',
      'provider_approval_pending',
      'subscription_required',
      'region_unavailable',
      'rollout_pending',
      'provider_deprecated',
    ]),
    message: z.string(),
    /** Machine-readable next step (plan §16). */
    agent_action: z.string(),
    /** Scopes that would lift the restriction, when that is what is missing. */
    required_scopes: z.array(z.string()).readonly().optional(),
  })
  .strict();

export type CapabilityRestriction = z.infer<typeof CapabilityRestrictionSchema>;

export const ProviderCapabilitiesSchema = z
  .object({
    schema_version: z.literal(CAPABILITY_SCHEMA_VERSION),
    provider: ProviderNameSchema,
    /** Adapter version that produced this document (plan §44). */
    adapter_version: z.string(),
    /**
     * `generic` for the platform, `effective` when narrowed to one destination.
     * A caller must not cache a `generic` document as if it were `effective`.
     */
    resolution: z.enum(['generic', 'effective']),
    publishing: PublishingCapabilitiesSchema,
    actions: ActionCapabilitiesSchema,
    constraints: CapabilityConstraintsSchema,
    /** Populated only for `effective`; explains every capability the destination lacks. */
    restrictions: z.array(CapabilityRestrictionSchema).readonly(),
    /** UTC ISO-8601 (Rule 15). */
    resolved_at: z.iso.datetime(),
  })
  .strict();

export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

/**
 * Baseline every adapter starts from, so adding a capability field to the schema does not
 * silently read as `true` for adapters that have not considered it. Everything is off and
 * unconstrained; an adapter opts in to what it actually supports.
 */
export const NO_CAPABILITIES: Omit<
  ProviderCapabilities,
  'provider' | 'adapter_version' | 'resolution' | 'resolved_at'
> = {
  schema_version: CAPABILITY_SCHEMA_VERSION,
  publishing: {
    text_only: false,
    image: false,
    video: false,
    carousel: false,
    story: false,
    reel: false,
    link_preview: false,
    poll: false,
    native_scheduling: false,
    thread: false,
  },
  actions: {
    delete_post: false,
    edit_post: false,
    comments_read: false,
    comments_reply: false,
    dm_send: false,
    analytics_read: false,
  },
  constraints: {
    max_text_length: null,
    max_media_count: null,
    max_image_bytes: null,
    max_video_bytes: null,
    max_video_duration_seconds: null,
    min_video_duration_seconds: null,
    supported_image_types: [],
    supported_video_types: [],
    supported_aspect_ratios: [],
    max_hashtags: null,
    max_mentions: null,
    allowed_privacy_levels: [],
    supports_alt_text: false,
  },
  restrictions: [],
};
