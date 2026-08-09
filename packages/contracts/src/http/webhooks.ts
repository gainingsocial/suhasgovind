import { z } from 'zod';

import { listResponseSchema, PaginationQuerySchema } from '../common/pagination.js';

/**
 * Customer webhook contracts (plan P8, §35, §36).
 *
 * Webhooks are a product surface, not an afterthought. Delivery is **at least once**, and
 * every event keeps one stable `event_id` across all of its attempts — that identifier is
 * what makes a customer's own deduplication possible, and without it at-least-once is
 * just "sometimes twice, good luck".
 */

/**
 * Event types (plan §37).
 *
 * Namespaced `resource.event` so a customer can subscribe to a family with a prefix
 * match, and so adding an event to an existing resource does not need a new namespace.
 */
export const WEBHOOK_EVENT_TYPES = [
  'post.created',
  'post.scheduled',
  'post.publishing',
  'post.published',
  /** Some targets succeeded and some did not — a first-class outcome, not an error. */
  'post.partially_published',
  'post.failed',
  'post.cancelled',
  'post_target.published',
  'post_target.failed',
  /** The provider accepted it and is transcoding; not yet live. */
  'post_target.processing',
  /** Outcome genuinely unknown; reconciliation is running. */
  'post_target.reconciliation_required',
  'connection.connected',
  'connection.health_changed',
  'connection.reauth_required',
  'connection.disconnected',
  'media.ready',
  'media.failed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

export const WebhookEndpointStatusSchema = z.enum([
  'enabled',
  'disabled',
  /** Disabled by us after sustained failure, so a dead endpoint stops burning retries. */
  'auto_disabled',
]);

export const WebhookEndpointSchema = z.object({
  id: z.string(),
  object: z.literal('webhook_endpoint'),
  url: z.url(),
  description: z.string().nullable(),
  status: WebhookEndpointStatusSchema,
  /** Empty means every event type. */
  event_types: z.array(WebhookEventTypeSchema),
  /** Non-null when the endpoint only hears about one profile. */
  profile_id: z.string().nullable(),
  /** Pinned, so a payload-shape change cannot silently break an existing integration. */
  api_version: z.string(),
  /** Bumping this rotates the signing secret. */
  secret_version: z.number().int(),
  consecutive_failures: z.number().int(),
  last_success_at: z.iso.datetime().nullable(),
  last_failure_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

/**
 * HTTPS only. A webhook body carries tenant data and is signed but not encrypted, so
 * plain HTTP would put it on the wire in the clear.
 */
const WebhookUrlSchema = z
  .url()
  .refine((value) => value.startsWith('https://'), {
    message: 'Webhook URLs must use https.',
  })
  .refine((value) => value.length <= 2000, { message: 'URL is too long.' });

export const CreateWebhookEndpointRequestSchema = z.object({
  url: WebhookUrlSchema,
  description: z.string().max(500).nullish(),
  /** Omit or send an empty array to receive every event type. */
  event_types: z.array(WebhookEventTypeSchema).default([]),
  profile_id: z.string().nullish(),
});

export const UpdateWebhookEndpointRequestSchema = z
  .object({
    url: WebhookUrlSchema.optional(),
    description: z.string().max(500).nullable().optional(),
    event_types: z.array(WebhookEventTypeSchema).optional(),
    /** `true` re-enables an endpoint we auto-disabled, and resets the failure counter. */
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Supply at least one field to update.',
  });

/**
 * Returned exactly once, at creation and at rotation.
 *
 * The secret is derived from a root in Secrets Store rather than stored (ADR-007), so it
 * genuinely cannot be shown again — which is the correct property for a signing key, and
 * the reason rotation exists.
 */
export const CreateWebhookEndpointResponseSchema = WebhookEndpointSchema.extend({
  signing_secret: z.string().describe('Shown once. Store it now; it cannot be retrieved later.'),
});

export const RotateWebhookSecretResponseSchema = z.object({
  id: z.string(),
  object: z.literal('webhook_endpoint'),
  secret_version: z.number().int(),
  signing_secret: z.string(),
  /**
   * The previous secret keeps verifying until this instant, so a customer can deploy the
   * new one without dropping deliveries in between.
   */
  previous_secret_valid_until: z.iso.datetime(),
});

export const WebhookDeliveryStatusSchema = z.enum([
  'pending',
  'delivering',
  'succeeded',
  'failed_retryable',
  /** Every retry used up. Moved to the DLQ; replayable by hand. */
  'exhausted',
]);

export const WebhookDeliverySchema = z.object({
  id: z.string(),
  object: z.literal('webhook_delivery'),
  webhook_endpoint_id: z.string(),
  /** Stable across every attempt for this event. Deduplicate on it. */
  event_id: z.string(),
  event_type: WebhookEventTypeSchema,
  status: WebhookDeliveryStatusSchema,
  attempt_count: z.number().int(),
  response_status: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  /** Scrubbed excerpt of the endpoint's response, for debugging (plan §36). */
  response_excerpt: z.string().nullable(),
  error_message: z.string().nullable(),
  next_attempt_at: z.iso.datetime().nullable(),
  delivered_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
});

export const WebhookEndpointListResponseSchema = listResponseSchema(WebhookEndpointSchema);
export const WebhookDeliveryListResponseSchema = listResponseSchema(WebhookDeliverySchema);

export const ListWebhookDeliveriesQuerySchema = PaginationQuerySchema.extend({
  status: WebhookDeliveryStatusSchema.optional(),
  event_type: WebhookEventTypeSchema.optional(),
});

export const DeleteWebhookEndpointResponseSchema = z.object({
  id: z.string(),
  object: z.literal('webhook_endpoint'),
  deleted: z.literal(true),
});

/** `POST /v1/webhooks/{id}/test` — sends a synthetic event so an integrator can wire up. */
export const TestWebhookResponseSchema = z.object({
  object: z.literal('webhook_delivery'),
  delivery_id: z.string(),
  event_id: z.string(),
  queued: z.literal(true),
});

export const ReplayWebhookDeliveryResponseSchema = z.object({
  object: z.literal('webhook_delivery'),
  /** A new delivery row; the original is left as the historical record. */
  delivery_id: z.string(),
  event_id: z.string(),
  queued: z.literal(true),
});
