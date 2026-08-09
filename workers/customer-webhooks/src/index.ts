import { toPublicId } from '@gs/contracts/ids';
import {
  decodeSecret,
  deriveWebhookSecret,
  signWebhookPayload,
  WEBHOOK_HEADERS,
} from '@gs/crypto';
import { createDatabaseFromEnv, leaseWebhookDelivery, recordDeliveryResult } from '@gs/db';
import { createLogger, newTraceContext, parseLogLevel } from '@gs/observability';

/**
 * Outbound customer webhook delivery (plan §35, §36, P8).
 *
 * At-least-once, and honest about it. Every attempt carries the same `event_id`, which is
 * what lets a customer deduplicate — promising at-least-once without a stable identifier
 * is just promising duplicates.
 *
 * The signature covers `timestamp.rawBody` over the exact bytes on the wire. Re-serializing
 * the payload here would produce a signature the customer cannot reproduce, because key
 * order and unicode escaping are not stable across JSON encoders. The stored payload is
 * therefore stringified once and signed and sent as-is.
 */

export interface Env {
  ENVIRONMENT: 'test' | 'live';
  SERVICE_VERSION: string;
  LOG_LEVEL: string;

  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;

  WEBHOOK_QUEUE?: Queue;

  /** Root the per-endpoint signing secrets derive from (ADR-007). */
  WEBHOOK_SIGNING_ROOT?: string;
}

export interface DeliverMessage {
  type: 'webhook.deliver';
  deliveryId: string;
  traceId?: string;
}

/**
 * Retry ladder from plan §36: 0s, 30s, 2m, 10m, 1h, 6h, 24h, then the DLQ.
 *
 * Spread deliberately wide at the tail. A customer endpoint that has been down for an hour
 * is usually down for a deploy or an incident, and hammering it every thirty seconds for a
 * day helps nobody — least of all the customer trying to bring it back up.
 */
const RETRY_SCHEDULE_SECONDS = [0, 30, 120, 600, 3_600, 21_600, 86_400] as const;

/** Endpoint timeout. A customer handler that is slow is a customer handler that is broken. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** How much of the response body to keep for debugging. Scrubbed, and never the whole thing. */
const RESPONSE_EXCERPT_LIMIT = 500;

/**
 * Consecutive failures before an endpoint is auto-disabled.
 *
 * High enough to ride out a long outage, low enough that a permanently dead endpoint stops
 * consuming retry capacity forever.
 */
const AUTO_DISABLE_THRESHOLD = 20;

function nextAttemptAt(attemptNumber: number): Date | null {
  const delay = RETRY_SCHEDULE_SECONDS[attemptNumber];
  // Past the end of the ladder: exhausted, no further attempt.
  return delay === undefined ? null : new Date(Date.now() + delay * 1000);
}

/**
 * Jitter within the scheduled slot.
 *
 * Thousands of deliveries created by one fan-out would otherwise retry in perfect
 * lockstep, turning a customer's brief outage into a synchronized flood the moment they
 * recover.
 */
function jittered(at: Date): Date {
  return new Date(at.getTime() + Math.floor(Math.random() * 30_000));
}

async function deliver(
  env: Env,
  message: DeliverMessage,
  logger: ReturnType<typeof createLogger>,
): Promise<'succeeded' | 'retrying' | 'exhausted' | 'skipped'> {
  const handle = createDatabaseFromEnv(env);

  try {
    // Same lease shape as the publish target: a queue redelivery must not double-send a
    // webhook, because a customer's handler may not be idempotent no matter what we
    // promise them.
    const leased = await leaseWebhookDelivery(handle.db, { deliveryId: message.deliveryId });
    if (!leased) return 'skipped';

    const { delivery, endpoint, event } = leased;

    if (endpoint.status !== 'enabled') {
      await recordDeliveryResult(handle.db, {
        deliveryId: delivery.id,
        leaseId: leased.leaseId,
        status: 'exhausted',
        error: `Endpoint is ${endpoint.status}.`,
      });
      return 'skipped';
    }

    if (!env.WEBHOOK_SIGNING_ROOT) {
      // Rule 14 — refuse to send rather than send something the customer cannot verify.
      throw new Error('WEBHOOK_SIGNING_ROOT is not configured.');
    }

    const secret = await deriveWebhookSecret(
      decodeSecret('WEBHOOK_SIGNING_ROOT', env.WEBHOOK_SIGNING_ROOT),
      endpoint.id,
      endpoint.secretVersion,
    );

    // Serialized once. These exact bytes are both signed and sent.
    const rawBody = JSON.stringify({
      id: toPublicId('event', event.id),
      object: 'event',
      type: event.eventType,
      api_version: event.apiVersion,
      created_at: event.createdAt.toISOString(),
      data: event.payload,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signWebhookPayload(secret, timestamp, rawBody);

    const attemptNumber = delivery.attemptCount + 1;
    const startedAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    let status: number | undefined;
    let excerpt: string | undefined;
    let failure: string | undefined;

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'GainingSocial-Webhooks/1.0',
          [WEBHOOK_HEADERS.eventId]: toPublicId('event', event.id),
          [WEBHOOK_HEADERS.timestamp]: String(timestamp),
          [WEBHOOK_HEADERS.signature]: signature,
          [WEBHOOK_HEADERS.attempt]: String(attemptNumber),
        },
        body: rawBody,
        signal: controller.signal,
        // Never follow a redirect. A customer endpoint that 302s could be pointed anywhere,
        // and we would happily deliver their tenant's data to it.
        redirect: 'manual',
      });

      status = response.status;
      excerpt = (await response.text()).slice(0, RESPONSE_EXCERPT_LIMIT);
    } catch (error) {
      failure = controller.signal.aborted
        ? `No response within ${DELIVERY_TIMEOUT_MS}ms.`
        : error instanceof Error
          ? error.message
          : String(error);
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - startedAt;
    // 2xx only. A 3xx is a redirect we deliberately did not follow, and a customer
    // returning 302 has not acknowledged anything.
    const succeeded = status !== undefined && status >= 200 && status < 300;

    if (succeeded) {
      await recordDeliveryResult(handle.db, {
        deliveryId: delivery.id,
        leaseId: leased.leaseId,
        status: 'succeeded',
        statusCode: status,
        durationMs,
        responseExcerpt: excerpt ?? null,
      });

      logger.info('webhook.delivered', {
        deliveryId: delivery.id,
        endpointId: endpoint.id,
        status,
        durationMs,
        attempt: attemptNumber,
      });
      return 'succeeded';
    }

    const retryAt = nextAttemptAt(attemptNumber);
    const exhausted = retryAt === null;

    await recordDeliveryResult(handle.db, {
      deliveryId: delivery.id,
      leaseId: leased.leaseId,
      status: exhausted ? 'exhausted' : 'failed_retryable',
      statusCode: status ?? null,
      durationMs,
      responseExcerpt: excerpt ?? null,
      error: failure ?? `Endpoint responded ${status}.`,
      nextAttemptAt: exhausted ? null : jittered(retryAt),
      autoDisableAfter: AUTO_DISABLE_THRESHOLD,
    });

    if (!exhausted && env.WEBHOOK_QUEUE) {
      await env.WEBHOOK_QUEUE.send(
        { type: 'webhook.deliver', deliveryId: delivery.id, traceId: message.traceId },
        { delaySeconds: Math.max(1, RETRY_SCHEDULE_SECONDS[attemptNumber] ?? 60) },
      );
    }

    logger[exhausted ? 'error' : 'warn'](
      exhausted ? 'webhook.exhausted' : 'webhook.retrying',
      {
        deliveryId: delivery.id,
        endpointId: endpoint.id,
        status,
        attempt: attemptNumber,
        reason: failure,
      },
    );

    return exhausted ? 'exhausted' : 'retrying';
  } finally {
    await handle.close();
  }
}

export default {
  async queue(batch: MessageBatch<DeliverMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      const trace = newTraceContext({ traceId: message.body.traceId });
      const logger = createLogger(trace, {
        service: 'customer-webhooks',
        level: parseLogLevel(env.LOG_LEVEL),
      });

      try {
        await deliver(env, message.body, logger);
        // Acked even when the delivery failed: the retry is scheduled in the database and
        // re-enqueued explicitly, so letting the queue retry as well would double the
        // attempt rate and desynchronize it from the recorded schedule.
        message.ack();
      } catch (error) {
        logger.error('webhook.delivery_crashed', {
          deliveryId: message.body.deliveryId,
          reason: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
    }
  },
};
