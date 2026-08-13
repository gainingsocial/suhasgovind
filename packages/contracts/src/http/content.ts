import { z } from 'zod';

import { ProviderNameSchema } from '../common/providers.js';
import { PaginationQuerySchema, listResponseSchema } from '../common/pagination.js';

/**
 * Content Intelligence and universal repurposing (plan §63Q).
 *
 * Two conventions here that are not decoration.
 *
 * A draft set is returned with its grounding, always, not behind a separate call. The whole
 * argument for generated social copy is that every factual claim traces back to something
 * the source actually said (P18), and a client that has to make a second request to find
 * out is a client that will ship without making it.
 *
 * `status` starts at `draft` and is moved by explicit transitions rather than by PATCH.
 * Approval is a decision with consequences, and modelling it as a field somebody sets makes
 * "approve" indistinguishable from "rename" in an audit log (P20).
 */

export const ContentSourceKindSchema = z.enum(['url', 'rss', 'upload', 'text']);

/**
 * How far a source is allowed to go on its own (plan §63T).
 *
 * `auto_publish_if_safe` still refuses anything whose grounding failed — "safe" is a
 * property of the content, not a permission the customer grants.
 */
export const AutomationModeSchema = z.enum([
  'draft_only',
  'approval_required',
  'auto_publish_if_safe',
]);

export const DraftSetStatusSchema = z.enum([
  'draft',
  'ready_for_review',
  'approved',
  'published',
  'discarded',
]);

// ---- sources ---------------------------------------------------------------

export const ContentSourceSchema = z
  .object({
    id: z.string(),
    object: z.literal('content_source'),
    kind: ContentSourceKindSchema,
    profile_id: z.string().nullable(),
    url: z.string().nullable(),
    name: z.string().nullable(),
    automation_mode: AutomationModeSchema,
    last_fetched_at: z.iso.datetime().nullable(),
    next_fetch_at: z.iso.datetime().nullable(),
    disabled_at: z.iso.datetime().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict();

export const CreateContentSourceRequestSchema = z
  .object({
    kind: ContentSourceKindSchema,
    /** Required for `url` and `rss`; meaningless for `text` and `upload`. */
    url: z.url().optional(),
    profile_id: z.string().optional(),
    name: z.string().max(200).optional(),
    automation_mode: AutomationModeSchema.optional(),
    metadata: z.record(z.string().max(64), z.unknown()).default({}),
  })
  .strict()
  .refine((value) => value.kind === 'text' || value.kind === 'upload' || Boolean(value.url), {
    message: 'url is required for url and rss sources',
    path: ['url'],
  });

export const UpdateContentSourceRequestSchema = z
  .object({
    name: z.string().max(200).nullish(),
    automation_mode: AutomationModeSchema.optional(),
    disabled: z.boolean().optional(),
    metadata: z.record(z.string().max(64), z.unknown()).optional(),
  })
  .strict();

export const ListContentSourcesQuerySchema = PaginationQuerySchema.extend({
  profile_id: z.string().optional(),
  include_disabled: z.coerce.boolean().default(false),
});

export const ContentSourceListResponseSchema = listResponseSchema(ContentSourceSchema);

export const DeleteContentSourceResponseSchema = z
  .object({
    id: z.string(),
    object: z.literal('content_source'),
    disabled: z.literal(true),
  })
  .strict();

// ---- ingestion and items ---------------------------------------------------

export const IngestContentRequestSchema = z
  .object({
    content_source_id: z.string(),
    /**
     * Your own identifier for this item within the source — an article id, a permalink.
     * Supplying it is what makes re-ingesting the same article an update rather than a
     * second item.
     */
    external_id: z.string().max(400),
    url: z.url().optional(),
    title: z.string().max(500).optional(),
    published_at: z.iso.datetime().optional(),
    /** Raw text or HTML. HTML is converted; scripts and comments never survive. */
    content: z.string().min(1).max(400_000),
    content_format: z.enum(['text', 'html']).default('text'),
  })
  .strict();

export const SourceSpanSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    /** Character offsets into the normalized text, so a span can be highlighted. */
    start: z.number().int(),
    end: z.number().int(),
  })
  .strict();

export const SourceItemSchema = z
  .object({
    id: z.string(),
    object: z.literal('source_item'),
    content_source_id: z.string(),
    external_id: z.string(),
    url: z.string().nullable(),
    title: z.string().nullable(),
    published_at: z.iso.datetime().nullable(),
    first_seen_at: z.iso.datetime(),
    created_at: z.iso.datetime(),
  })
  .strict();

export const SourceItemVersionSchema = z
  .object({
    id: z.string(),
    object: z.literal('source_item_version'),
    content_hash: z.string(),
    /**
     * True when the ingested text pattern-matched a prompt-injection attempt (§63S). A
     * signal for review, never a gate — detection is the weakest of the three defences,
     * and the other two do not depend on it.
     */
    injection_suspected: z.boolean(),
    span_count: z.number().int(),
    fetched_at: z.iso.datetime(),
  })
  .strict();

export const ContentExtractionSchema = z
  .object({
    id: z.string(),
    object: z.literal('content_extraction'),
    content_type: z.string().nullable(),
    title: z.string().nullable(),
    one_sentence_summary: z.string().nullable(),
    extraction: z.record(z.string(), z.unknown()),
    model: z.string().nullable(),
    prompt_version: z.string().nullable(),
    /**
     * True when the source was too long and was cut. An extraction of truncated text is
     * not an extraction of that source, and a reader has to be able to tell.
     */
    input_truncated: z.boolean(),
    created_at: z.iso.datetime(),
  })
  .strict();

export const IngestContentResponseSchema = z
  .object({
    object: z.literal('ingest_result'),
    item: SourceItemSchema,
    version: SourceItemVersionSchema,
    /**
     * False when this exact text was already stored. Unchanged content is never
     * re-analyzed (§63R), so a repeat ingest is cheap and safe to run on a schedule.
     */
    version_is_new: z.boolean(),
  })
  .strict();

export const SourceItemDetailSchema = SourceItemSchema.extend({
  latest_version: SourceItemVersionSchema.nullable(),
  extraction: ContentExtractionSchema.nullable(),
  spans: z.array(SourceSpanSchema),
});

export const ListSourceItemsQuerySchema = PaginationQuerySchema.extend({
  content_source_id: z.string().optional(),
});

export const SourceItemListResponseSchema = listResponseSchema(SourceItemSchema);

// ---- draft sets ------------------------------------------------------------

export const GroundingClaimSchema = z
  .object({
    claim_text: z.string(),
    claim_kind: z.string(),
    /** Ids of the spans in the source version that support this claim. */
    source_span_ids: z.array(z.string()),
    verified: z.boolean(),
    failure_reason: z.string().nullable(),
  })
  .strict();

export const SocialDraftSchema = z
  .object({
    id: z.string(),
    object: z.literal('social_draft'),
    provider: ProviderNameSchema,
    destination_id: z.string().nullable(),
    body: z.string(),
    media_ids: z.array(z.string()),
    /** The post this draft became, once somebody published it. */
    post_id: z.string().nullable(),
    claims: z.array(GroundingClaimSchema),
  })
  .strict();

export const DraftSetSchema = z
  .object({
    id: z.string(),
    object: z.literal('draft_set'),
    status: DraftSetStatusSchema,
    profile_id: z.string(),
    title: z.string().nullable(),
    /**
     * True when any generated claim could not be traced to a source span. A set with this
     * true is never eligible for automatic publishing, whatever the source's automation
     * mode says (P18).
     */
    grounding_failed: z.boolean(),
    drafts: z.array(SocialDraftSchema),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict();

export const RepurposeRequestSchema = z
  .object({
    source_item_id: z.string(),
    profile_id: z.string(),
    /** Where this should be adapted for. Each becomes one draft. */
    destination_ids: z.array(z.string()).min(1).max(20),
  })
  .strict();

export const ListDraftSetsQuerySchema = PaginationQuerySchema.extend({
  profile_id: z.string().optional(),
  status: DraftSetStatusSchema.optional(),
});

export const DraftSetListResponseSchema = listResponseSchema(
  DraftSetSchema.omit({ drafts: true }).extend({ draft_count: z.number().int() }),
);

export const UpdateDraftSetRequestSchema = z
  .object({
    title: z.string().max(300).nullish(),
    /** Edits to individual drafts. Editing a body re-runs grounding against the source. */
    drafts: z
      .array(
        z
          .object({
            id: z.string(),
            body: z.string().max(20_000).optional(),
            media_ids: z.array(z.string()).max(20).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    /**
     * An explicit transition. Separate from the edits above so an approval is never a side
     * effect of a rename (P20).
     */
    status: z.enum(['ready_for_review', 'approved', 'discarded']).optional(),
  })
  .strict();

export const PublishDraftSetRequestSchema = z
  .object({
    /** Publish only these drafts. Omit for every draft in the set. */
    draft_ids: z.array(z.string()).max(20).optional(),
    publish_at: z.iso.datetime().nullish(),
  })
  .strict();

export const PublishDraftSetResponseSchema = z
  .object({
    id: z.string(),
    object: z.literal('draft_set'),
    status: DraftSetStatusSchema,
    /** The post created from the set. Publishing is asynchronous as always (P3). */
    post_id: z.string(),
    published_draft_count: z.number().int(),
  })
  .strict();

// ---- brand profile (plan §63K) --------------------------------------------

export const BrandProfileSchema = z
  .object({
    object: z.literal('brand_profile'),
    profile_id: z.string(),
    tone: z.string().nullable(),
    audience: z.string().nullable(),
    /**
     * Enforced as a check on generated drafts rather than only as a prompt instruction,
     * because a prompt is a request and a check is a guarantee.
     */
    banned_phrases: z.array(z.string()),
    required_disclosures: z.array(z.string()),
    style_notes: z.string().nullable(),
    updated_at: z.iso.datetime(),
  })
  .strict();

export const UpsertBrandProfileRequestSchema = z
  .object({
    tone: z.string().max(2000).nullish(),
    audience: z.string().max(2000).nullish(),
    banned_phrases: z.array(z.string().max(200)).max(200).default([]),
    required_disclosures: z.array(z.string().max(500)).max(50).default([]),
    style_notes: z.string().max(8000).nullish(),
  })
  .strict();

export type ContentSourceShape = z.infer<typeof ContentSourceSchema>;
export type DraftSetShape = z.infer<typeof DraftSetSchema>;
export type BrandProfileShape = z.infer<typeof BrandProfileSchema>;
