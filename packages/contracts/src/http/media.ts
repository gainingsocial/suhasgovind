import { z } from 'zod';

import { MediaKindSchema } from '../providers/capabilities.js';
import { TargetValidationResultSchema } from '../providers/validation.js';

/**
 * Media contracts (plan §31).
 *
 * Upload is a three-step flow rather than a multipart POST:
 *
 *   POST /v1/media/uploads            → presigned URL + media id
 *   PUT  <presigned url>              → client uploads straight to R2
 *   POST /v1/media/uploads/{id}/complete → probe metadata, mark ready
 *
 * The bytes never pass through the Worker. A 200 MB video through a Worker would blow
 * both the request-size limit and the CPU budget, and Rule 10 forbids long-running work
 * in the request path regardless.
 */

export const MediaStatusSchema = z.enum([
  /** Presigned URL issued; the client has not confirmed the upload. */
  'awaiting_upload',
  'uploaded',
  'probing',
  /** Metadata is known and the asset can be attached to a post. */
  'ready',
  'failed',
  'deleted',
]);

export const MediaSourceSchema = z.enum(['upload', 'external_url', 'derived']);

export const MediaSchema = z.object({
  id: z.string(),
  object: z.literal('media'),
  profile_id: z.string(),
  status: MediaStatusSchema,
  source: MediaSourceSchema,
  /** Null until probed — the client's claimed type is not trusted for this. */
  kind: MediaKindSchema.nullable(),
  filename: z.string().nullable(),
  mime_type: z.string().nullable(),
  byte_size: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  duration_seconds: z.number().nullable(),
  aspect_ratio: z.number().nullable(),
  /**
   * Null until probed. Several platforms reject silent video for Reels and Shorts, so
   * this drives a preflight warning rather than a publish-time failure.
   */
  has_audio: z.boolean().nullable(),
  alt_text: z.string().nullable(),
  /** Why probing failed, when it did. */
  probe_error: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type Media = z.infer<typeof MediaSchema>;

/**
 * Declared content type and size.
 *
 * Both are advisory: the probe on completion is what the system actually trusts. They are
 * still required, because they let an obviously-wrong upload be rejected before a client
 * spends bandwidth on it.
 */
export const CreateMediaUploadRequestSchema = z.object({
  profile_id: z.string(),
  filename: z.string().min(1).max(500),
  mime_type: z.string().min(3).max(255),
  /** Bytes. Checked against the plan limit before a URL is issued. */
  byte_size: z.number().int().positive(),
  alt_text: z.string().max(2000).nullish(),
});

export const CreateMediaUploadResponseSchema = z.object({
  id: z.string(),
  object: z.literal('media_upload'),
  /** PUT the raw bytes here. Short-lived. */
  upload_url: z.url(),
  /** Headers that must be sent with the PUT for the signature to validate. */
  upload_headers: z.record(z.string(), z.string()),
  upload_method: z.literal('PUT'),
  expires_at: z.iso.datetime(),
  media: MediaSchema,
});

export const CompleteMediaUploadResponseSchema = MediaSchema;

/**
 * Register media the caller already hosts (plan §31 "direct external HTTPS media URLs").
 *
 * The URL is validated against the SSRF rules in plan §68 before anything fetches it —
 * a provider fetching an attacker-supplied URL from our network is the classic version of
 * that bug.
 */
export const CreateExternalMediaRequestSchema = z.object({
  profile_id: z.string(),
  url: z.url(),
  alt_text: z.string().max(2000).nullish(),
});

export const DeleteMediaResponseSchema = z.object({
  id: z.string(),
  object: z.literal('media'),
  deleted: z.literal(true),
});

/**
 * Media preflight (plan §14, §18, P16).
 *
 * Answers "will this asset be accepted on these platforms" without composing a post. The
 * separation matters because media is the expensive half: a 200 MB video that Instagram
 * will reject on aspect ratio should be discovered before it is uploaded anywhere, not
 * after a post is composed around it.
 */
export const MediaPreflightRequestSchema = z.object({
  media_ids: z.array(z.string()).min(1).max(20),
  /** Check against these destinations. Their effective capability is what is applied. */
  destination_ids: z.array(z.string()).min(1).max(50),
});

export const MediaPreflightResponseSchema = z.object({
  object: z.literal('media_preflight'),
  /** True only when every asset is acceptable on every named destination. */
  valid: z.boolean(),
  /**
   * The same per-target shape post preflight returns. Deliberately identical: a client
   * that can render one set of findings can render both, and a second shape would mean
   * two renderers that drift.
   */
  targets: z.array(TargetValidationResultSchema),
});
