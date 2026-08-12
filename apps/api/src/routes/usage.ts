import { UsageResponseSchema } from '@gs/contracts/http';
import { summarizeUsage, usageByDay, usageDate, type UsageMetric } from '@gs/db';
import { ApiError } from '@gs/errors';
import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware/authenticate.js';
import { withDatabase } from '../middleware/database.js';

/**
 * Usage reporting (plan §70).
 *
 * Summed from the immutable event log, not from the rolled-up counters. §70 is explicit:
 * *"do not calculate invoices directly from mutable counters alone."* A counter is an
 * optimization that can drift — a double increment, a lost update, a migration that resets
 * one — and this is the number a customer reconciles against their own records.
 *
 * The counters still exist and are still used, for quota checks on the request path where
 * being approximately right in a millisecond beats being exactly right in fifty.
 */
export const usage = new Hono<AppEnv>();

/** The longest window a single query may span. Longer belongs in an export, not a request. */
const MAX_RANGE_DAYS = 366;

function parseDate(value: string | undefined, fallback: string, param: string): string {
  if (!value) return fallback;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError('INVALID_REQUEST', {
      message: `\`${param}\` must be a UTC date in YYYY-MM-DD form.`,
      param,
    });
  }

  return value;
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

usage.get('/', withDatabase(), authenticate(['analytics:read']), async (c) => {
  const principal = c.get('principal');

  const today = usageDate();
  const defaultFrom = usageDate(new Date(Date.now() - 29 * 86_400_000));

  const from = parseDate(c.req.query('from'), defaultFrom, 'from');
  const to = parseDate(c.req.query('to'), today, 'to');

  const span = daysBetween(from, to);
  if (span < 0) {
    throw new ApiError('INVALID_REQUEST', { message: '`from` must not be after `to`.', param: 'from' });
  }
  if (span > MAX_RANGE_DAYS) {
    throw new ApiError('INVALID_REQUEST', {
      message: `The range may not exceed ${MAX_RANGE_DAYS} days.`,
      param: 'to',
    });
  }

  /**
   * Scoped to the key's own environment, always.
   *
   * Usage is organization-level data, and an API key belongs to one environment inside it.
   * Reporting the organization total to a key scoped to `test` would tell a sandbox
   * integration how much production traffic its owner is doing (P5).
   */
  const summary = await summarizeUsage(c.get('db'), {
    organizationId: principal.organizationId,
    projectEnvironmentId: principal.projectEnvironmentId,
    from,
    to,
  });

  const metric = c.req.query('metric') as UsageMetric | undefined;
  const daily = metric
    ? await usageByDay(c.get('db'), {
        organizationId: principal.organizationId,
        projectEnvironmentId: principal.projectEnvironmentId,
        metric,
        from,
        to,
      })
    : [];

  return c.json(
    UsageResponseSchema.parse({
      object: 'usage',
      from,
      to,
      // Rule 15 — the buckets are UTC dates, so a customer in Auckland and one in
      // California reconcile against the same numbers rather than two different days.
      totals: summary.map((row) => ({ metric: row.metric, quantity: row.quantity })),
      daily: daily.map((row) => ({ date: row.date, quantity: row.quantity })),
    }),
    200,
  );
});
