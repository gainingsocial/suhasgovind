import type { DomainEvent, DomainEventType } from './domain-events.js';

/**
 * Customer-facing webhook events (plan §35, §36).
 *
 * This is a PUBLIC contract. Event names and payload shapes are versioned by
 * `api_version`; removing or renaming one is a breaking change (plan §69).
 *
 * Not every domain event becomes a webhook. Internal events like `post.target.leased`
 * exist for observability and would only be noise in a customer's endpoint.
 */
export const WEBHOOK_EVENT_TYPES = [
  'connection.connected',
  'connection.reauth_required',
  'connection.disconnected',

  'post.accepted',
  'post.scheduled',
  'post.publishing',
  'post.published',
  'post.partially_published',
  'post.failed',
  'post.cancelled',

  'post.target.publishing',
  'post.target.published',
  'post.target.failed',

  'media.ready',
  'media.failed',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set<string>(WEBHOOK_EVENT_TYPES);

export function isWebhookEventType(value: string): value is WebhookEventType {
  return WEBHOOK_EVENT_SET.has(value);
}

/**
 * The exact JSON body delivered to a customer endpoint.
 *
 * `event_id` is stable across every delivery attempt of the same event, which is what
 * makes a customer's own deduplication possible — deliveries are at-least-once (plan §36).
 */
export interface WebhookEventEnvelope {
  event_id: string;
  type: WebhookEventType;
  created_at: string;
  api_version: string;
  project_id: string;
  environment: 'test' | 'live';
  profile_id?: string;
  data: Record<string, unknown>;
}

/**
 * Domain event → customer webhook name.
 *
 * `null` means "internal only". Being explicit about every domain event, rather than
 * defaulting to pass-through, means adding an internal event cannot accidentally start
 * broadcasting implementation detail to customers.
 */
const DOMAIN_TO_WEBHOOK: Record<DomainEventType, WebhookEventType | null> = {
  'connection.connected': 'connection.connected',
  'connection.destinations_discovered': null,
  // Health transitions are mapped by the dispatcher, which knows the target state:
  // only `reauth_required` and `disconnected` are customer-visible.
  'connection.health_changed': null,
  'connection.credential_refreshed': null,
  'connection.disconnected': 'connection.disconnected',

  'media.upload_completed': null,
  'media.probed': null,
  'media.ready': 'media.ready',
  'media.failed': 'media.failed',

  'post.created': 'post.accepted',
  'post.validated': null,
  'post.approval_requested': null,
  'post.approved': null,
  'post.rejected': null,
  'post.scheduled': 'post.scheduled',
  'post.queued': null,
  // Mapped by the dispatcher from the post's new aggregate status.
  'post.status_changed': null,
  'post.cancelled': 'post.cancelled',

  'post.target.queued': null,
  'post.target.leased': null,
  'post.target.preparing_media': null,
  'post.target.publishing': 'post.target.publishing',
  'post.target.provider_processing': null,
  'post.target.published': 'post.target.published',
  'post.target.failed': 'post.target.failed',
  'post.target.reconciliation_required': null,
  'post.target.reconciled': null,
  'post.target.cancelled': null,

  'webhook.delivery_succeeded': null,
  'webhook.delivery_failed': null,
  'webhook.delivery_exhausted': null,

  'usage.recorded': null,
  'audit.action_performed': null,
};

export function webhookTypeForDomainEvent(type: DomainEventType): WebhookEventType | null {
  return DOMAIN_TO_WEBHOOK[type];
}

/** Post aggregate status → the webhook that announces it (plan §12.1, §35). */
export function webhookTypeForPostStatus(status: string): WebhookEventType | null {
  switch (status) {
    case 'scheduled':
      return 'post.scheduled';
    case 'publishing':
      return 'post.publishing';
    case 'published':
      return 'post.published';
    case 'partially_published':
      return 'post.partially_published';
    case 'failed':
      return 'post.failed';
    case 'cancelled':
      return 'post.cancelled';
    default:
      return null;
  }
}

/** Connection health → the webhook that announces it (plan §12.3, §42). */
export function webhookTypeForConnectionHealth(health: string): WebhookEventType | null {
  switch (health) {
    case 'reauth_required':
    case 'permission_missing':
    case 'revoked':
      return 'connection.reauth_required';
    case 'disconnected':
      return 'connection.disconnected';
    case 'healthy':
      return null;
    default:
      return null;
  }
}

export interface BuildWebhookEnvelopeInput {
  event: Pick<DomainEvent, 'id' | 'occurredAt' | 'projectId' | 'environment' | 'profileId'>;
  type: WebhookEventType;
  apiVersion: string;
  data: Record<string, unknown>;
}

export function buildWebhookEnvelope(input: BuildWebhookEnvelopeInput): WebhookEventEnvelope {
  return {
    event_id: input.event.id,
    type: input.type,
    created_at: input.event.occurredAt,
    api_version: input.apiVersion,
    project_id: input.event.projectId,
    environment: input.event.environment,
    ...(input.event.profileId ? { profile_id: input.event.profileId } : {}),
    data: input.data,
  };
}

/**
 * Webhook retry schedule (plan §36).
 *
 * Delays in seconds between attempts: immediate, 30s, 2m, 10m, 1h, 6h, 24h — then the
 * delivery is exhausted and moved to the DLQ. Jitter is applied at dispatch so a
 * provider-wide incident does not produce a synchronized retry stampede.
 */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [0, 30, 120, 600, 3600, 21_600, 86_400] as const;

export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SECONDS.length;

export interface NextWebhookAttempt {
  attempt: number;
  delaySeconds: number;
  scheduledAt: Date;
}

/**
 * Compute the next delivery attempt, or `null` when the schedule is exhausted.
 *
 * `attemptsMade` counts deliveries already tried; the first call passes 0.
 */
export function nextWebhookAttempt(
  attemptsMade: number,
  options: { now?: Date; jitterRatio?: number; random?: () => number } = {},
): NextWebhookAttempt | null {
  if (attemptsMade >= WEBHOOK_MAX_ATTEMPTS) return null;

  const base = WEBHOOK_RETRY_DELAYS_SECONDS[attemptsMade]!;
  const now = options.now ?? new Date();
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;

  // Full-jitter within ±jitterRatio, never negative.
  const jitter = base * jitterRatio * (random() * 2 - 1);
  const delaySeconds = Math.max(0, Math.round(base + jitter));

  return {
    attempt: attemptsMade + 1,
    delaySeconds,
    scheduledAt: new Date(now.getTime() + delaySeconds * 1000),
  };
}
