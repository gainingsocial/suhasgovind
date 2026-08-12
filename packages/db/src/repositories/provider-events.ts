import { newUuidV7 } from '@gs/contracts/ids';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { socialConnections, type SocialConnection } from '../schema/connections.js';
import { providerEvents, type ProviderEvent } from '../schema/operations.js';

/**
 * Inbound provider webhook events (plan §34, §10.4).
 *
 * The ingress does exactly two things before acknowledging: verify, and land the event
 * here. Everything else happens on the queue. Providers ack-or-retry on a short deadline —
 * Meta drops an unacknowledged notification after 36 hours of retries — and a slow handler
 * turns one provider incident into a flood of redeliveries.
 */

export interface RecordProviderEventInput {
  provider: string;
  /** The provider's own id when it supplies one; `null` makes `fingerprint` load-bearing. */
  providerEventId: string | null;
  /** Hash of the payload, used only when the provider supplies no stable id (plan §10.4). */
  fingerprint: string | null;
  eventType: string | null;
  signatureVerified: boolean;
  payload: Record<string, unknown>;
  traceId: string | null;
}

export interface RecordedProviderEvent {
  id: string;
  /** True when this exact event was already stored — the caller must do nothing further. */
  duplicate: boolean;
}

/**
 * Store an inbound event, deduplicated.
 *
 * `ON CONFLICT DO NOTHING` across both partial unique indexes, with no conflict target:
 * an event may be deduplicated by provider id *or* by fingerprint depending on what the
 * provider sends, and naming one target would leave the other path duplicating silently.
 *
 * An empty `RETURNING` is the duplicate signal. That makes redelivery a no-op insert
 * rather than a read-then-write, which under concurrent redeliveries of the same event —
 * the normal case during a provider retry storm — would let both callers see "not present"
 * and both proceed (plan P4).
 */
export async function recordProviderEvent(
  db: Database,
  input: RecordProviderEventInput,
): Promise<RecordedProviderEvent> {
  const id = newUuidV7();

  const inserted = await db
    .insert(providerEvents)
    .values({
      id,
      provider: input.provider,
      providerEventId: input.providerEventId,
      fingerprint: input.fingerprint,
      eventType: input.eventType,
      signatureVerified: input.signatureVerified,
      payload: input.payload,
      traceId: input.traceId,
    })
    .onConflictDoNothing()
    .returning({ id: providerEvents.id });

  const row = inserted[0];
  return row ? { id: row.id, duplicate: false } : { id, duplicate: true };
}

/**
 * Attach the tenant an event turned out to belong to.
 *
 * Deliberately separate from the insert: a webhook arrives before we know whose it is, and
 * resolving the connection means a query the ingress must not spend its ack budget on.
 */
export async function attachProviderEventOwner(
  db: Database,
  eventId: string,
  owner: { connectionId: string | null; projectEnvironmentId: string | null },
): Promise<void> {
  await db
    .update(providerEvents)
    .set({
      connectionId: owner.connectionId,
      projectEnvironmentId: owner.projectEnvironmentId,
    })
    .where(eq(providerEvents.id, eventId));
}

/**
 * Close out an event.
 *
 * A processing failure still stamps `processed_at`, with the reason alongside. Leaving it
 * NULL would put the event back in the unprocessed sweep forever, and an event that fails
 * deterministically — an unparseable payload, a deleted connection — fails identically on
 * every retry. The row stays queryable for forensics either way.
 */
export async function markProviderEventProcessed(
  db: Database,
  eventId: string,
  processingError: string | null = null,
): Promise<void> {
  await db
    .update(providerEvents)
    .set({ processedAt: new Date(), processingError })
    .where(eq(providerEvents.id, eventId));
}

/**
 * Read one stored event.
 *
 * The queue message carries only an id, so the payload is always re-read here. A payload
 * carried on the queue would be a snapshot from delivery time, and a message redelivered
 * hours later must act on the row as it stands — including the possibility that another
 * delivery already processed it.
 */
export async function findProviderEventById(
  db: Database,
  providerEventId: string,
): Promise<ProviderEvent | null> {
  const rows = await db
    .select()
    .from(providerEvents)
    .where(eq(providerEvents.id, providerEventId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Events that were stored but never processed — the safety net for an enqueue that failed
 * after the row landed (plan §27's reconciler pattern applied to ingress).
 */
export async function findUnprocessedProviderEvents(
  db: Database,
  options: { olderThan: Date; limit: number },
): Promise<ProviderEvent[]> {
  return db
    .select()
    .from(providerEvents)
    .where(
      and(
        isNull(providerEvents.processedAt),
        eq(providerEvents.signatureVerified, true),
        lt(providerEvents.receivedAt, options.olderThan),
      ),
    )
    .orderBy(asc(providerEvents.receivedAt))
    .limit(options.limit);
}

/**
 * Every live connection for one provider-side account.
 *
 * Returns a list, not a row. The same Facebook Page can legitimately be connected by two
 * different customers of ours, and a revocation webhook concerns all of them. Picking the
 * first match would leave the others publishing with a credential the platform has already
 * invalidated.
 */
export async function findConnectionsByProviderAccount(
  db: Database,
  provider: string,
  providerAccountId: string,
): Promise<SocialConnection[]> {
  return db
    .select()
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.provider, provider),
        eq(socialConnections.providerAccountId, providerAccountId),
        isNull(socialConnections.disconnectedAt),
      ),
    );
}

/**
 * Purge processed events past their retention window.
 *
 * Provider events are high-volume and their forensic value is short-lived; the durable
 * record of what actually changed lives on the connection and its health history.
 */
export async function purgeProviderEvents(db: Database, olderThan: Date): Promise<number> {
  const deleted = await db
    .delete(providerEvents)
    .where(and(sql`${providerEvents.processedAt} IS NOT NULL`, lt(providerEvents.receivedAt, olderThan)))
    .returning({ id: providerEvents.id });
  return deleted.length;
}
