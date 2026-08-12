import { newUuidV7 } from '@gs/contracts/ids';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import { usageCounters, usageEvents, type UsageEvent } from '../schema/operations.js';

/**
 * Usage metering (plan §70).
 *
 * Designed now, monetized later — and the ordering matters. Usage that was never recorded
 * cannot be reconstructed after the fact, so a product that adds metering at the point it
 * decides to charge starts with no history to charge against and no way to answer a
 * customer asking what they used last month.
 *
 * Two layers, deliberately:
 *
 *   usage_events    immutable, one row per billable action, recorded at the moment it
 *                   happened. The source of truth.
 *   usage_counters  rolled-up totals for fast quota checks on the request path.
 *
 * Plan §70 is explicit: *"do not calculate invoices directly from mutable counters alone."*
 * A counter is an optimization that can drift — a double increment, a lost update, a
 * migration that resets one. An invoice disputed by a customer has to be answerable from
 * the events, and only the events.
 */

/** The metrics this system records. Plan §70 lists the intended vocabulary. */
export const USAGE_METRICS = [
  'api_request',
  'post_target_attempt',
  'successful_publish',
  'connected_account_day',
  'media_processed_minute',
  'media_storage_byte_day',
  'analytics_sync',
  'webhook_delivery',
  'source_fetch',
  'source_item_processed',
  'llm_input_tokens',
  'llm_output_tokens',
  'repurpose_job',
] as const;

export type UsageMetric = (typeof USAGE_METRICS)[number];

export interface RecordUsageInput {
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  profileId?: string | null;
  metric: UsageMetric;
  quantity?: number;
  provider?: string | null;
  /**
   * The thing that caused this usage.
   *
   * Supplying it is what makes recording idempotent *and* what makes a dispute
   * resolvable — "you were charged for these 412 publishes, here they are" is a different
   * conversation from "our counter says 412".
   */
  resourceType?: string | null;
  resourceId?: string | null;
  traceId?: string | null;
  occurredAt?: Date;
}

/** UTC date bucket, `YYYY-MM-DD`. Rule 15 — never a local date. */
export function usageDate(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** UTC month bucket, `YYYY-MM`. */
export function usageMonth(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

/**
 * Record one billable action.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique index on
 * `(metric, resource_type, resource_id)`. A queue redelivery that re-records "post
 * published" for the same target cannot double-bill, which matters because every consumer
 * in this system is at-least-once (P4) and billing is the one place a duplicate is not
 * merely untidy.
 *
 * Events without a resource id — an API request, say — are genuinely one per occurrence
 * and are exempt from that index, since deduplicating them would silently under-count.
 */
export async function recordUsage(
  db: Database | Transaction,
  input: RecordUsageInput,
): Promise<{ recorded: boolean }> {
  const occurredAt = input.occurredAt ?? new Date();

  const inserted = await db
    .insert(usageEvents)
    .values({
      id: newUuidV7(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      projectEnvironmentId: input.projectEnvironmentId,
      profileId: input.profileId ?? null,
      metric: input.metric,
      quantity: input.quantity ?? 1,
      provider: input.provider ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      usageDate: usageDate(occurredAt),
      traceId: input.traceId ?? null,
      occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: usageEvents.id });

  return { recorded: inserted.length > 0 };
}

/**
 * Bump the rolled-up counter for a metric.
 *
 * Separate from `recordUsage` and called only when that reported a new row, so a
 * deduplicated redelivery does not increment. An upsert with `value = value + n` rather
 * than a read-then-write, because two workers recording concurrently is the normal case
 * and a read-then-write loses one of them.
 */
export async function incrementUsageCounter(
  db: Database | Transaction,
  input: {
    organizationId: string;
    projectEnvironmentId: string | null;
    metric: UsageMetric;
    period: string;
    quantity?: number;
  },
): Promise<void> {
  const quantity = input.quantity ?? 1;

  await db
    .insert(usageCounters)
    .values({
      id: newUuidV7(),
      organizationId: input.organizationId,
      projectEnvironmentId: input.projectEnvironmentId,
      metric: input.metric,
      period: input.period,
      value: quantity,
    })
    .onConflictDoUpdate({
      target: [
        usageCounters.organizationId,
        usageCounters.projectEnvironmentId,
        usageCounters.metric,
        usageCounters.period,
      ],
      set: {
        value: sql`${usageCounters.value} + ${quantity}`,
        updatedAt: new Date(),
      },
    });
}

/**
 * Record and count in one call.
 *
 * The counter only moves when the event was genuinely new. Incrementing regardless would
 * make the fast path disagree with the source of truth after the first redelivery, and a
 * quota that rejects a customer because a queue retried is a support ticket that looks
 * exactly like a bug in their code.
 */
export async function meter(db: Database, input: RecordUsageInput): Promise<void> {
  const { recorded } = await recordUsage(db, input);
  if (!recorded) return;

  const occurredAt = input.occurredAt ?? new Date();

  await incrementUsageCounter(db, {
    organizationId: input.organizationId,
    projectEnvironmentId: input.projectEnvironmentId,
    metric: input.metric,
    period: usageMonth(occurredAt),
    quantity: input.quantity ?? 1,
  });
}

export interface UsageSummaryRow {
  metric: string;
  quantity: number;
}

/**
 * Usage over a period, summed from the **events**.
 *
 * Deliberately not read from `usage_counters`, even though that would be faster. This is
 * the number a customer sees and an invoice is built from, and plan §70 requires it to
 * come from the immutable record rather than a counter that may have drifted. The counters
 * exist for quota checks on the hot path, where being approximately right in a millisecond
 * beats being exactly right in fifty.
 */
export async function summarizeUsage(
  db: Database,
  input: {
    organizationId: string;
    projectEnvironmentId?: string | null;
    from: string;
    to: string;
  },
): Promise<UsageSummaryRow[]> {
  const conditions = [
    eq(usageEvents.organizationId, input.organizationId),
    gte(usageEvents.usageDate, input.from),
    lte(usageEvents.usageDate, input.to),
  ];

  if (input.projectEnvironmentId) {
    conditions.push(eq(usageEvents.projectEnvironmentId, input.projectEnvironmentId));
  }

  const rows = await db
    .select({
      metric: usageEvents.metric,
      quantity: sql<number>`sum(${usageEvents.quantity})::int`,
    })
    .from(usageEvents)
    .where(and(...conditions))
    .groupBy(usageEvents.metric);

  return rows.map((row) => ({ metric: row.metric, quantity: Number(row.quantity) }));
}

/** Daily breakdown for one metric, for a usage chart. */
export async function usageByDay(
  db: Database,
  input: {
    organizationId: string;
    projectEnvironmentId?: string | null;
    metric: UsageMetric;
    from: string;
    to: string;
  },
): Promise<{ date: string; quantity: number }[]> {
  const conditions = [
    eq(usageEvents.organizationId, input.organizationId),
    eq(usageEvents.metric, input.metric),
    gte(usageEvents.usageDate, input.from),
    lte(usageEvents.usageDate, input.to),
  ];

  if (input.projectEnvironmentId) {
    conditions.push(eq(usageEvents.projectEnvironmentId, input.projectEnvironmentId));
  }

  const rows = await db
    .select({
      date: usageEvents.usageDate,
      quantity: sql<number>`sum(${usageEvents.quantity})::int`,
    })
    .from(usageEvents)
    .where(and(...conditions))
    .groupBy(usageEvents.usageDate)
    .orderBy(usageEvents.usageDate);

  return rows.map((row) => ({ date: row.date, quantity: Number(row.quantity) }));
}

/** The fast path: a rolled-up total, for a quota check that runs on every request. */
export async function readUsageCounter(
  db: Database,
  input: {
    organizationId: string;
    projectEnvironmentId: string | null;
    metric: UsageMetric;
    period: string;
  },
): Promise<number> {
  const rows = await db
    .select({ value: usageCounters.value })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.organizationId, input.organizationId),
        input.projectEnvironmentId
          ? eq(usageCounters.projectEnvironmentId, input.projectEnvironmentId)
          : sql`${usageCounters.projectEnvironmentId} IS NULL`,
        eq(usageCounters.metric, input.metric),
        eq(usageCounters.period, input.period),
      ),
    )
    .limit(1);

  return rows[0]?.value ?? 0;
}

/** Recent raw events, for the "what exactly was I charged for?" question. */
export async function listUsageEvents(
  db: Database,
  input: {
    organizationId: string;
    metric?: UsageMetric;
    limit: number;
  },
): Promise<UsageEvent[]> {
  const conditions = [eq(usageEvents.organizationId, input.organizationId)];
  if (input.metric) conditions.push(eq(usageEvents.metric, input.metric));

  return db
    .select()
    .from(usageEvents)
    .where(and(...conditions))
    .orderBy(desc(usageEvents.occurredAt))
    .limit(input.limit);
}
