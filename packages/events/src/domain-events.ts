import { newId } from '@gs/contracts/ids';

/**
 * Internal domain events (plan §37).
 *
 * Business logic emits these; it does not call the webhook dispatcher. That indirection
 * is the whole point: analytics, billing, the audit log, notifications and (later) agent
 * memory all subscribe to the same stream without the publishing engine knowing they
 * exist.
 *
 * These are NOT the customer-facing webhook payloads. The mapping from a domain event to
 * a customer webhook lives in `webhook-events.ts`, so we can change internal event shape
 * without breaking a customer's integration.
 */

export const DOMAIN_EVENT_TYPES = [
  // connections
  'connection.connected',
  'connection.destinations_discovered',
  'connection.health_changed',
  'connection.credential_refreshed',
  'connection.disconnected',

  // media
  'media.upload_completed',
  'media.probed',
  'media.ready',
  'media.failed',

  // posts
  'post.created',
  'post.validated',
  'post.approval_requested',
  'post.approved',
  'post.rejected',
  'post.scheduled',
  'post.queued',
  'post.status_changed',
  'post.cancelled',

  // targets
  'post.target.queued',
  'post.target.leased',
  'post.target.preparing_media',
  'post.target.publishing',
  'post.target.provider_processing',
  'post.target.published',
  'post.target.failed',
  'post.target.reconciliation_required',
  'post.target.reconciled',
  'post.target.cancelled',

  // webhooks
  'webhook.delivery_succeeded',
  'webhook.delivery_failed',
  'webhook.delivery_exhausted',

  // usage / audit
  'usage.recorded',
  'audit.action_performed',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  /** Stable internal UUID. Also the customer-facing `event_id` when this becomes a webhook. */
  id: string;
  type: T;
  /** The entity this event is about — post ID, target ID, connection ID. */
  aggregateId: string;
  aggregateType: 'post' | 'post_target' | 'connection' | 'media' | 'webhook_endpoint' | 'project';
  /** UTC ISO-8601 (plan §85 Rule 15). */
  occurredAt: string;
  traceId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  environment: 'test' | 'live';
  profileId?: string;
  payload: Record<string, unknown>;
}

export interface EmitEventInput<T extends DomainEventType = DomainEventType> {
  type: T;
  aggregateId: string;
  aggregateType: DomainEvent['aggregateType'];
  traceId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  environment: 'test' | 'live';
  profileId?: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export function createDomainEvent<T extends DomainEventType>(input: EmitEventInput<T>): DomainEvent<T> {
  return {
    id: newId('event').publicId,
    type: input.type,
    aggregateId: input.aggregateId,
    aggregateType: input.aggregateType,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    traceId: input.traceId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    environment: input.environment,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    payload: input.payload ?? {},
  };
}

/**
 * Minimal in-process bus.
 *
 * Handler failures are isolated: one broken subscriber must never fail a publish that
 * already succeeded at the provider. Failures are reported through `onHandlerError`
 * rather than thrown.
 */
export type DomainEventHandler = (event: DomainEvent) => void | Promise<void>;

export class DomainEventBus {
  private readonly handlers = new Map<DomainEventType | '*', Set<DomainEventHandler>>();

  constructor(private readonly onHandlerError?: (error: unknown, event: DomainEvent) => void) {}

  on(type: DomainEventType | '*', handler: DomainEventHandler): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  async emit(event: DomainEvent): Promise<void> {
    const subscribers = [
      ...(this.handlers.get(event.type) ?? []),
      ...(this.handlers.get('*') ?? []),
    ];

    // The `async` wrapper matters: a handler that throws *synchronously* would otherwise
    // escape `allSettled`, because the map callback throws before a promise exists.
    const results = await Promise.allSettled(subscribers.map(async (handler) => handler(event)));

    for (const result of results) {
      if (result.status === 'rejected') {
        this.onHandlerError?.(result.reason, event);
      }
    }
  }
}
