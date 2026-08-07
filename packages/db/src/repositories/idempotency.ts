import { and, eq, lt, sql } from 'drizzle-orm';

import { newUuidV7 } from '@gs/contracts/ids';

import type { Database, Transaction } from '../client.js';
import { idempotencyKeys } from '../schema/idempotency.js';

/**
 * Atomic idempotency reservation (plan §77, ADR-006 Layer 1).
 *
 * The whole mechanism is the unique index on `(project_environment_id, key)` combined
 * with `INSERT ... ON CONFLICT DO NOTHING`. Two concurrent requests carrying the same
 * key race on the index, and exactly one wins — which is the specific gap Ayrshare
 * documents in its own implementation (plan §2.2).
 *
 * An application-level "SELECT then INSERT" is NOT equivalent, because the two statements
 * can interleave. Do not refactor this into one.
 */

export type ReservationOutcome =
  /** This caller won. Proceed to create the resource, then call `completeReservation`. */
  | { kind: 'reserved'; reservationId: string }
  /** A previous identical request already finished. Replay its stored response verbatim. */
  | {
      kind: 'replay';
      resourceType: string | null;
      resourceId: string | null;
      responseSnapshot: Record<string, unknown> | null;
      responseStatus: string | null;
    }
  /** An identical request is still running. The caller should retry shortly. */
  | { kind: 'in_progress' }
  /** Same key, different body. A genuine client error (409). */
  | { kind: 'conflict' }
  /** The previous attempt failed; this caller may take over and try again. */
  | { kind: 'retry_after_failure'; reservationId: string };

export interface ReserveIdempotencyInput {
  projectEnvironmentId: string;
  projectId: string;
  organizationId: string;
  key: string;
  /** SHA-256 of the canonicalized request body (see `canonicalizeForHashing`). */
  requestHash: string;
  /** Route identifier, so one key cannot be reused across different operations. */
  endpoint: string;
  apiKeyId?: string;
  requestId?: string;
  traceId?: string;
  /** How long the record is honoured for replay. Default 24 hours. */
  ttlSeconds?: number;
  now?: Date;
}

const DEFAULT_TTL_SECONDS = 86_400;

/**
 * Reserve a key, or discover what a previous identical request did.
 *
 * Must run inside the same transaction that creates the resource, so a crash between
 * reservation and creation rolls both back rather than leaving a key reserved for a post
 * that does not exist.
 */
export async function reserveIdempotency(
  tx: Database | Transaction,
  input: ReserveIdempotencyInput,
): Promise<ReservationOutcome> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000);
  const reservationId = newUuidV7();

  const inserted = await tx
    .insert(idempotencyKeys)
    .values({
      id: reservationId,
      projectEnvironmentId: input.projectEnvironmentId,
      projectId: input.projectId,
      organizationId: input.organizationId,
      key: input.key,
      requestHash: input.requestHash,
      endpoint: input.endpoint,
      status: 'in_progress',
      apiKeyId: input.apiKeyId ?? null,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      expiresAt,
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [idempotencyKeys.projectEnvironmentId, idempotencyKeys.key],
    })
    .returning({ id: idempotencyKeys.id });

  if (inserted.length > 0) {
    return { kind: 'reserved', reservationId };
  }

  // Someone else holds the key. Read their record to decide what this caller sees.
  const [existing] = await tx
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.projectEnvironmentId, input.projectEnvironmentId),
        eq(idempotencyKeys.key, input.key),
      ),
    )
    .limit(1);

  if (!existing) {
    // The row vanished between the failed insert and this read — only possible if the
    // sweeper deleted an expired record in the gap. Treat as a conflict rather than
    // guessing; the caller retries and wins the insert next time.
    return { kind: 'conflict' };
  }

  // A different body under the same key is always an error, even if the first request
  // failed. Silently returning the first result for a different request would be worse.
  if (existing.requestHash !== input.requestHash || existing.endpoint !== input.endpoint) {
    return { kind: 'conflict' };
  }

  if (existing.status === 'completed') {
    return {
      kind: 'replay',
      resourceType: existing.resourceType,
      resourceId: existing.resourceId,
      responseSnapshot: existing.responseSnapshot,
      responseStatus: existing.responseStatus,
    };
  }

  if (existing.status === 'failed') {
    return { kind: 'retry_after_failure', reservationId: existing.id };
  }

  return { kind: 'in_progress' };
}

export interface CompleteReservationInput {
  reservationId: string;
  resourceType: string;
  resourceId: string;
  /** The exact response body, so a replay is byte-identical to the original. */
  responseSnapshot: Record<string, unknown>;
  responseStatus: string;
  now?: Date;
}

export async function completeReservation(
  tx: Database | Transaction,
  input: CompleteReservationInput,
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({
      status: 'completed',
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      responseSnapshot: input.responseSnapshot,
      responseStatus: input.responseStatus,
      completedAt: input.now ?? new Date(),
    })
    .where(eq(idempotencyKeys.id, input.reservationId));
}

/**
 * Mark a reservation failed so a later retry with the same key can take over.
 *
 * Called on a path that will NOT be rolled back — for example when the resource was
 * created but a subsequent step failed. When the whole transaction rolls back, the
 * reservation disappears with it and this is unnecessary.
 */
export async function failReservation(
  db: Database,
  reservationId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ status: 'failed', completedAt: now })
    .where(eq(idempotencyKeys.id, reservationId));
}

/** Sweep expired keys. Run by the reconciler cron; keeps the table bounded. */
export async function purgeExpiredIdempotencyKeys(
  db: Database,
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 5000;

  const deleted = await db
    .delete(idempotencyKeys)
    .where(
      sql`${idempotencyKeys.id} IN (
        SELECT id FROM ${idempotencyKeys}
        WHERE ${lt(idempotencyKeys.expiresAt, now)}
        LIMIT ${limit}
      )`,
    )
    .returning({ id: idempotencyKeys.id });

  return deleted.length;
}
