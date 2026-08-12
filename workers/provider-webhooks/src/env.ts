import type { VerifiedProviderEvent } from '@gs/provider-kit';

/**
 * Inbound provider webhook ingress bindings (plan §34).
 *
 * Narrow on purpose. This worker verifies a signature, writes one row and enqueues. It has
 * no R2, no rate limiter and no publish queue, because none of those can be reached inside
 * a provider's acknowledgment budget.
 */
export interface Env {
  ENVIRONMENT: 'test' | 'live';
  SERVICE_VERSION: string;
  LOG_LEVEL: string;

  /** Pooled Postgres (ADR-003). */
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;

  /** Decrypts the app secret each provider signs with (plan §7.1). */
  CREDENTIAL_KEK_V1?: string;
  CREDENTIAL_KEK_V2?: string;
  CREDENTIAL_KEK_ACTIVE_VERSION?: string;

  /** Where verified events go for processing, after the provider has been acknowledged. */
  PROVIDER_EVENT_QUEUE?: Queue;
  /** Customer-facing consequences — `connection.reauth_required` and friends. */
  WEBHOOK_QUEUE?: Queue;

  /** Root the per-app subscription verify tokens derive from (ADR-007). */
  WEBHOOK_SIGNING_ROOT?: string;

  PUBLIC_API_ORIGIN?: string;
}

/**
 * One stored event, ready to process.
 *
 * The message carries the row id and nothing else that matters. The payload is re-read
 * from the database rather than carried on the queue: a queue message is at-least-once and
 * may be redelivered days later, and processing must act on the row as it stands — which
 * may by then already be marked processed by the delivery that won.
 */
export interface ProviderEventMessage {
  type: 'provider.event';
  providerEventId: string;
  provider: string;
  traceId?: string;
}

/** The normalized event alongside the row it was stored as. */
export interface StoredProviderEvent {
  rowId: string;
  provider: string;
  event: VerifiedProviderEvent;
}
