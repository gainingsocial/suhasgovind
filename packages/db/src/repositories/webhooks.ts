import { newUuidV7 } from '@gs/contracts/ids';
import { ApiError } from '@gs/errors';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import {
  outboundWebhookEvents,
  webhookDeliveries,
  webhookEndpoints,
  webhookSubscriptions,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '../schema/webhooks.js';

/**
 * Webhook repository (plan §35, §36, §76).
 *
 * One event fans out to every subscribed endpoint, and each of those deliveries carries
 * its own independent retry state. That separation is why `outbound_webhook_events` and
 * `webhook_deliveries` are different tables: a slow endpoint must not hold up a fast one,
 * and a replay must not resend to endpoints that already succeeded.
 */

export interface EndpointWithSubscriptions extends WebhookEndpoint {
  eventTypes: string[];
}

async function subscriptionsFor(
  db: Database,
  endpointIds: string[],
): Promise<Map<string, string[]>> {
  const byEndpoint = new Map<string, string[]>();
  if (endpointIds.length === 0) return byEndpoint;

  const rows = await db
    .select({
      endpointId: webhookSubscriptions.webhookEndpointId,
      eventType: webhookSubscriptions.eventType,
    })
    .from(webhookSubscriptions)
    .where(inArray(webhookSubscriptions.webhookEndpointId, endpointIds));

  for (const row of rows) {
    byEndpoint.set(row.endpointId, [...(byEndpoint.get(row.endpointId) ?? []), row.eventType]);
  }
  return byEndpoint;
}

export interface CreateEndpointInput {
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  url: string;
  description: string | null;
  eventTypes: readonly string[];
  profileId: string | null;
  apiVersion: string;
}

export async function createWebhookEndpoint(
  db: Database,
  input: CreateEndpointInput,
): Promise<EndpointWithSubscriptions> {
  const id = newUuidV7();

  const rows = await db
    .insert(webhookEndpoints)
    .values({
      id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      projectEnvironmentId: input.projectEnvironmentId,
      url: input.url,
      description: input.description,
      profileId: input.profileId,
      apiVersion: input.apiVersion,
      status: 'enabled',
    })
    .returning();

  const created = rows[0];
  if (!created) throw new ApiError('INTERNAL_ERROR', { message: 'Webhook insert returned no row.' });

  if (input.eventTypes.length > 0) {
    await db
      .insert(webhookSubscriptions)
      .values(input.eventTypes.map((eventType) => ({ id: newUuidV7(), webhookEndpointId: id, eventType })));
  }

  return { ...created, eventTypes: [...input.eventTypes] };
}

export async function findWebhookEndpointById(
  db: Database,
  projectEnvironmentId: string,
  endpointId: string,
): Promise<EndpointWithSubscriptions | null> {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const subs = await subscriptionsFor(db, [row.id]);
  return { ...row, eventTypes: subs.get(row.id) ?? [] };
}

export async function listWebhookEndpoints(
  db: Database,
  input: { projectEnvironmentId: string; limit: number; order: 'asc' | 'desc'; cursor?: string },
): Promise<{ rows: EndpointWithSubscriptions[]; hasMore: boolean }> {
  const conditions = [eq(webhookEndpoints.projectEnvironmentId, input.projectEnvironmentId)];
  if (input.cursor) {
    conditions.push(
      input.order === 'desc'
        ? lt(webhookEndpoints.id, input.cursor)
        : gt(webhookEndpoints.id, input.cursor),
    );
  }

  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(and(...conditions))
    .orderBy(input.order === 'desc' ? desc(webhookEndpoints.id) : asc(webhookEndpoints.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const subs = await subscriptionsFor(db, page.map((r) => r.id));

  return {
    rows: page.map((row) => ({ ...row, eventTypes: subs.get(row.id) ?? [] })),
    hasMore,
  };
}

export interface UpdateEndpointInput {
  url?: string;
  description?: string | null;
  eventTypes?: readonly string[];
  enabled?: boolean;
}

export async function updateWebhookEndpoint(
  db: Database,
  projectEnvironmentId: string,
  endpointId: string,
  input: UpdateEndpointInput,
): Promise<EndpointWithSubscriptions | null> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (input.url !== undefined) patch.url = input.url;
  if (input.description !== undefined) patch.description = input.description;
  if (input.enabled !== undefined) {
    patch.status = input.enabled ? 'enabled' : 'disabled';
    if (input.enabled) {
      // Re-enabling clears the auto-disable state. Leaving the counter would mean an
      // endpoint that was fixed gets disabled again on its very next hiccup.
      patch.consecutiveFailures = 0;
      patch.autoDisabledAt = null;
    }
  }

  const rows = await db
    .update(webhookEndpoints)
    .set(patch)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .returning();

  const updated = rows[0];
  if (!updated) return null;

  if (input.eventTypes !== undefined) {
    // Replace rather than merge: the caller sent the complete desired set, and merging
    // would make removing a subscription impossible.
    await db
      .delete(webhookSubscriptions)
      .where(eq(webhookSubscriptions.webhookEndpointId, endpointId));

    if (input.eventTypes.length > 0) {
      await db.insert(webhookSubscriptions).values(
        input.eventTypes.map((eventType) => ({
          id: newUuidV7(),
          webhookEndpointId: endpointId,
          eventType,
        })),
      );
    }
    return { ...updated, eventTypes: [...input.eventTypes] };
  }

  const subs = await subscriptionsFor(db, [endpointId]);
  return { ...updated, eventTypes: subs.get(endpointId) ?? [] };
}

export async function deleteWebhookEndpoint(
  db: Database,
  projectEnvironmentId: string,
  endpointId: string,
): Promise<boolean> {
  const rows = await db
    .delete(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .returning({ id: webhookEndpoints.id });

  return rows.length > 0;
}

export async function rotateWebhookSecret(
  db: Database,
  projectEnvironmentId: string,
  endpointId: string,
): Promise<number | null> {
  const rows = await db
    .update(webhookEndpoints)
    .set({
      secretVersion: sql`${webhookEndpoints.secretVersion} + 1`,
      secretRotatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .returning({ secretVersion: webhookEndpoints.secretVersion });

  return rows[0]?.secretVersion ?? null;
}

// ---------------------------------------------------------------------------
// Events and deliveries
// ---------------------------------------------------------------------------

export interface EmitEventInput {
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  profileId: string | null;
  eventType: string;
  apiVersion: string;
  payload: Record<string, unknown>;
  aggregateType?: string;
  aggregateId?: string;
  traceId?: string;
}

/**
 * Record an event and fan it out to every endpoint that wants it.
 *
 * One transaction, so an event never exists without its deliveries — an event row with no
 * delivery would sit in the database looking sent while nothing was ever attempted.
 *
 * An endpoint with no subscriptions receives everything. That is the useful default: the
 * common first integration wants all events, and requiring an explicit list would make
 * the simplest case the most tedious one.
 */
export async function emitWebhookEvent(
  db: Database,
  input: EmitEventInput,
): Promise<{ eventId: string; deliveryIds: string[] }> {
  return db.transaction(async (tx: Transaction) => {
    const eventId = newUuidV7();

    await tx.insert(outboundWebhookEvents).values({
      id: eventId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      projectEnvironmentId: input.projectEnvironmentId,
      profileId: input.profileId,
      eventType: input.eventType,
      apiVersion: input.apiVersion,
      payload: input.payload,
      aggregateType: input.aggregateType ?? null,
      aggregateId: input.aggregateId ?? null,
      traceId: input.traceId ?? null,
    });

    const candidates = await tx
      .select({
        id: webhookEndpoints.id,
        profileId: webhookEndpoints.profileId,
      })
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.projectEnvironmentId, input.projectEnvironmentId),
          eq(webhookEndpoints.status, 'enabled'),
        ),
      );

    const subs = await subscriptionsFor(db, candidates.map((c) => c.id));

    const matching = candidates.filter((endpoint) => {
      // A profile-scoped endpoint only hears about its own profile.
      if (endpoint.profileId && endpoint.profileId !== input.profileId) return false;
      const wanted = subs.get(endpoint.id) ?? [];
      return wanted.length === 0 || wanted.includes(input.eventType);
    });

    if (matching.length === 0) return { eventId, deliveryIds: [] };

    const deliveries = matching.map((endpoint) => ({
      id: newUuidV7(),
      eventId,
      webhookEndpointId: endpoint.id,
      projectEnvironmentId: input.projectEnvironmentId,
      status: 'pending' as const,
      nextAttemptAt: new Date(),
    }));

    await tx.insert(webhookDeliveries).values(deliveries);
    return { eventId, deliveryIds: deliveries.map((d) => d.id) };
  });
}

export interface DeliveryWithEvent extends WebhookDelivery {
  eventType: string;
  eventPublicId: string;
}

export async function listWebhookDeliveries(
  db: Database,
  input: {
    projectEnvironmentId: string;
    endpointId: string;
    limit: number;
    order: 'asc' | 'desc';
    cursor?: string;
    status?: WebhookDelivery['status'];
    eventType?: string;
  },
): Promise<{ rows: DeliveryWithEvent[]; hasMore: boolean }> {
  const conditions = [
    eq(webhookDeliveries.webhookEndpointId, input.endpointId),
    eq(webhookDeliveries.projectEnvironmentId, input.projectEnvironmentId),
  ];

  if (input.status) conditions.push(eq(webhookDeliveries.status, input.status));
  if (input.eventType) conditions.push(eq(outboundWebhookEvents.eventType, input.eventType));
  if (input.cursor) {
    conditions.push(
      input.order === 'desc'
        ? lt(webhookDeliveries.id, input.cursor)
        : gt(webhookDeliveries.id, input.cursor),
    );
  }

  const rows = await db
    .select({
      delivery: webhookDeliveries,
      eventType: outboundWebhookEvents.eventType,
      eventId: outboundWebhookEvents.id,
    })
    .from(webhookDeliveries)
    .innerJoin(outboundWebhookEvents, eq(outboundWebhookEvents.id, webhookDeliveries.eventId))
    .where(and(...conditions))
    .orderBy(input.order === 'desc' ? desc(webhookDeliveries.id) : asc(webhookDeliveries.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;

  return {
    rows: page.map((row) => ({ ...row.delivery, eventType: row.eventType, eventPublicId: row.eventId })),
    hasMore,
  };
}

export async function findWebhookDeliveryById(
  db: Database,
  projectEnvironmentId: string,
  deliveryId: string,
): Promise<DeliveryWithEvent | null> {
  const rows = await db
    .select({
      delivery: webhookDeliveries,
      eventType: outboundWebhookEvents.eventType,
      eventId: outboundWebhookEvents.id,
    })
    .from(webhookDeliveries)
    .innerJoin(outboundWebhookEvents, eq(outboundWebhookEvents.id, webhookDeliveries.eventId))
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  const row = rows[0];
  return row ? { ...row.delivery, eventType: row.eventType, eventPublicId: row.eventId } : null;
}

/**
 * Queue a fresh delivery for an existing event.
 *
 * A new row rather than resetting the old one, with `replayOfDeliveryId` pointing back.
 * The original stays as the historical record — a support conversation about "why did
 * this fail" needs the failure to still exist, and the partial unique index deliberately
 * excludes replays so this does not collide with it.
 */
export async function replayWebhookDelivery(
  db: Database,
  original: WebhookDelivery,
): Promise<string> {
  const id = newUuidV7();

  await db.insert(webhookDeliveries).values({
    id,
    eventId: original.eventId,
    webhookEndpointId: original.webhookEndpointId,
    projectEnvironmentId: original.projectEnvironmentId,
    status: 'pending',
    nextAttemptAt: new Date(),
    replayOfDeliveryId: original.id,
  });

  return id;
}

/** Deliveries due for an attempt. Drives the delivery sweeper. */
export async function findDueDeliveries(
  db: Database,
  limit: number,
  now: Date = new Date(),
): Promise<WebhookDelivery[]> {
  return db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        inArray(webhookDeliveries.status, ['pending', 'failed_retryable']),
        lt(webhookDeliveries.nextAttemptAt, now),
        isNull(webhookDeliveries.leaseId),
      ),
    )
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Delivery execution
// ---------------------------------------------------------------------------

export interface LeasedDelivery {
  delivery: WebhookDelivery;
  endpoint: WebhookEndpoint;
  event: {
    id: string;
    eventType: string;
    apiVersion: string;
    payload: Record<string, unknown>;
    createdAt: Date;
  };
  leaseId: string;
}

/**
 * Acquire the exclusive right to attempt one delivery.
 *
 * The same conditional-UPDATE shape as the publish target lease, and for the same reason:
 * queue delivery is at-least-once, so a redelivery must not cause a second POST to the
 * customer. We promise at-least-once to them, but that is a promise about our retries —
 * sending the same attempt twice because our own queue hiccuped is just a bug.
 */
export async function leaseWebhookDelivery(
  db: Database,
  input: { deliveryId: string; leaseSeconds?: number; now?: Date },
): Promise<LeasedDelivery | null> {
  const now = input.now ?? new Date();
  const leaseId = newUuidV7();
  const leaseExpiresAt = new Date(now.getTime() + (input.leaseSeconds ?? 120) * 1000);

  const [leased] = await db
    .update(webhookDeliveries)
    .set({
      status: 'delivering',
      leaseId,
      leaseExpiresAt,
      attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(webhookDeliveries.id, input.deliveryId),
        inArray(webhookDeliveries.status, ['pending', 'failed_retryable']),
        or(isNull(webhookDeliveries.leaseExpiresAt), lt(webhookDeliveries.leaseExpiresAt, now)),
      ),
    )
    .returning();

  if (!leased) return null;

  const [context] = await db
    .select({ endpoint: webhookEndpoints, event: outboundWebhookEvents })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.webhookEndpointId))
    .innerJoin(outboundWebhookEvents, eq(outboundWebhookEvents.id, webhookDeliveries.eventId))
    .where(eq(webhookDeliveries.id, input.deliveryId))
    .limit(1);

  if (!context) return null;

  return {
    delivery: leased,
    endpoint: context.endpoint,
    event: {
      id: context.event.id,
      eventType: context.event.eventType,
      apiVersion: context.event.apiVersion,
      payload: context.event.payload,
      createdAt: context.event.createdAt,
    },
    leaseId,
  };
}

export interface RecordDeliveryResultInput {
  deliveryId: string;
  leaseId: string;
  status: 'succeeded' | 'failed_retryable' | 'exhausted';
  statusCode?: number | null;
  durationMs?: number;
  responseExcerpt?: string | null;
  error?: string | null;
  nextAttemptAt?: Date | null;
  /** Disable the endpoint once consecutive failures reach this. */
  autoDisableAfter?: number;
  now?: Date;
}

/**
 * Record the outcome and update the endpoint's health.
 *
 * One transaction, because the delivery row and the endpoint's failure counter have to
 * agree: a delivery recorded as failed while the counter says the endpoint is healthy
 * would let a dead endpoint retry forever.
 */
export async function recordDeliveryResult(
  db: Database,
  input: RecordDeliveryResultInput,
): Promise<void> {
  const now = input.now ?? new Date();
  const succeeded = input.status === 'succeeded';

  await db.transaction(async (tx: Transaction) => {
    const [updated] = await tx
      .update(webhookDeliveries)
      .set({
        status: input.status,
        leaseId: null,
        leaseExpiresAt: null,
        lastStatusCode: input.statusCode ?? null,
        lastDurationMs: input.durationMs ?? null,
        lastResponseExcerpt: input.responseExcerpt ?? null,
        lastError: input.error ?? null,
        nextAttemptAt: input.nextAttemptAt ?? null,
        deliveredAt: succeeded ? now : null,
        exhaustedAt: input.status === 'exhausted' ? now : null,
        updatedAt: now,
      })
      // Lease-guarded, so a worker whose lease expired cannot overwrite the outcome
      // recorded by whoever took the delivery over.
      .where(
        and(eq(webhookDeliveries.id, input.deliveryId), eq(webhookDeliveries.leaseId, input.leaseId)),
      )
      .returning({ endpointId: webhookDeliveries.webhookEndpointId });

    if (!updated) return;

    if (succeeded) {
      await tx
        .update(webhookEndpoints)
        .set({ consecutiveFailures: 0, lastSuccessAt: now, autoDisabledAt: null, updatedAt: now })
        .where(eq(webhookEndpoints.id, updated.endpointId));
      return;
    }

    const threshold = input.autoDisableAfter ?? Number.MAX_SAFE_INTEGER;

    await tx
      .update(webhookEndpoints)
      .set({
        consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
        lastFailureAt: now,
        // Auto-disable in the same statement as the increment, so the decision is made
        // against the value being written rather than a separately-read stale one.
        status: sql`CASE WHEN ${webhookEndpoints.consecutiveFailures} + 1 >= ${threshold}
                         THEN 'auto_disabled'::webhook_endpoint_status
                         ELSE ${webhookEndpoints.status} END`,
        autoDisabledAt: sql`CASE WHEN ${webhookEndpoints.consecutiveFailures} + 1 >= ${threshold}
                                 THEN ${now} ELSE ${webhookEndpoints.autoDisabledAt} END`,
        updatedAt: now,
      })
      .where(eq(webhookEndpoints.id, updated.endpointId));
  });
}
