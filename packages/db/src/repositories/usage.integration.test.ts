import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseHandle, type Database, type DatabaseHandle } from '../client.js';
import { createTenantHarness, databaseUrl, type TenantHarness } from '../test-support/seed.js';
import {
  listUsageEvents,
  meter,
  readUsageCounter,
  recordUsage,
  summarizeUsage,
  usageByDay,
  usageDate,
  usageMonth,
} from './usage.js';

/**
 * Usage metering (plan §70).
 *
 * The property worth defending: a queue redelivery must not double-bill. Every consumer in
 * this system is at-least-once, and billing is the one place where a duplicate is not
 * merely untidy — it is a charge the customer did not incur and cannot see the cause of.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('usage metering', () => {
  let h: TenantHarness;
  let handle: DatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    h = await createTenantHarness([]);
    handle = createDatabaseHandle({ connectionString: h.connectionString, max: 2 });
    db = handle.db;
  });

  afterAll(async () => {
    await handle?.close();
    await h?.cleanup();
  });

  const tenancy = () => ({
    organizationId: h.tenantA.organizationId,
    projectId: h.tenantA.projectId,
    projectEnvironmentId: h.tenantA.projectEnvironmentId,
  });

  it('records a billable action', async () => {
    const result = await recordUsage(db, {
      ...tenancy(),
      metric: 'successful_publish',
      resourceType: 'post_target',
      resourceId: crypto.randomUUID(),
    });

    expect(result.recorded).toBe(true);
  });

  it('does not double-bill a redelivered event', async () => {
    // The property that makes an at-least-once publisher safe to meter from.
    const resourceId = crypto.randomUUID();
    const input = {
      ...tenancy(),
      metric: 'successful_publish' as const,
      resourceType: 'post_target',
      resourceId,
    };

    expect((await recordUsage(db, input)).recorded).toBe(true);
    expect((await recordUsage(db, input)).recorded).toBe(false);
  });

  it('counts every occurrence of an event that has no resource id', async () => {
    // An API request is genuinely one per occurrence. Deduplicating those would silently
    // under-count, which is the opposite failure and just as wrong.
    const before = await summarizeUsage(db, {
      ...tenancy(),
      from: usageDate(),
      to: usageDate(),
    });
    const previous = before.find((row) => row.metric === 'api_request')?.quantity ?? 0;

    await recordUsage(db, { ...tenancy(), metric: 'api_request' });
    await recordUsage(db, { ...tenancy(), metric: 'api_request' });

    const after = await summarizeUsage(db, { ...tenancy(), from: usageDate(), to: usageDate() });
    expect(after.find((row) => row.metric === 'api_request')?.quantity).toBe(previous + 2);
  });

  it('moves the counter only when the event was genuinely new', async () => {
    // A counter that drifts from the event log would make a quota reject a customer
    // because a queue retried — a support ticket that looks exactly like a bug in their
    // own code.
    const resourceId = crypto.randomUUID();
    const input = {
      ...tenancy(),
      metric: 'webhook_delivery' as const,
      resourceType: 'delivery',
      resourceId,
    };

    await meter(db, input);
    const afterFirst = await readUsageCounter(db, {
      organizationId: h.tenantA.organizationId,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
      metric: 'webhook_delivery',
      period: usageMonth(),
    });

    await meter(db, input);
    const afterSecond = await readUsageCounter(db, {
      organizationId: h.tenantA.organizationId,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
      metric: 'webhook_delivery',
      period: usageMonth(),
    });

    expect(afterSecond).toBe(afterFirst);
  });

  it('accumulates the counter across distinct events', async () => {
    const before = await readUsageCounter(db, {
      organizationId: h.tenantA.organizationId,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
      metric: 'repurpose_job',
      period: usageMonth(),
    });

    await meter(db, {
      ...tenancy(),
      metric: 'repurpose_job',
      resourceType: 'job',
      resourceId: crypto.randomUUID(),
    });
    await meter(db, {
      ...tenancy(),
      metric: 'repurpose_job',
      resourceType: 'job',
      resourceId: crypto.randomUUID(),
    });

    const after = await readUsageCounter(db, {
      organizationId: h.tenantA.organizationId,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
      metric: 'repurpose_job',
      period: usageMonth(),
    });

    expect(after).toBe(before + 2);
  });

  it('respects a quantity greater than one', async () => {
    await meter(db, {
      ...tenancy(),
      metric: 'llm_input_tokens',
      quantity: 1_500,
      resourceType: 'llm_run',
      resourceId: crypto.randomUUID(),
    });

    const summary = await summarizeUsage(db, { ...tenancy(), from: usageDate(), to: usageDate() });
    expect(summary.find((row) => row.metric === 'llm_input_tokens')?.quantity).toBe(1_500);
  });

  it('never reports one tenant’s usage to another', async () => {
    await meter(db, {
      ...tenancy(),
      metric: 'analytics_sync',
      resourceType: 'sync',
      resourceId: crypto.randomUUID(),
    });

    const other = await summarizeUsage(db, {
      organizationId: h.tenantB.organizationId,
      projectEnvironmentId: h.tenantB.projectEnvironmentId,
      from: usageDate(),
      to: usageDate(),
    });

    expect(other.find((row) => row.metric === 'analytics_sync')).toBeUndefined();
  });

  it('buckets by UTC date so two timezones reconcile against one number', async () => {
    const at = new Date('2026-03-15T23:30:00Z');
    expect(usageDate(at)).toBe('2026-03-15');
    expect(usageMonth(at)).toBe('2026-03');
  });

  it('returns a daily series for one metric', async () => {
    await meter(db, {
      ...tenancy(),
      metric: 'source_fetch',
      resourceType: 'fetch',
      resourceId: crypto.randomUUID(),
    });

    const series = await usageByDay(db, {
      ...tenancy(),
      metric: 'source_fetch',
      from: usageDate(),
      to: usageDate(),
    });

    expect(series).toMatchObject([{ date: usageDate() }]);
  });

  it('lists the raw events behind a charge', async () => {
    // "You were charged for these, here they are" is a different conversation from "our
    // counter says so".
    const resourceId = crypto.randomUUID();
    await meter(db, {
      ...tenancy(),
      metric: 'media_processed_minute',
      resourceType: 'media',
      resourceId,
    });

    const events = await listUsageEvents(db, {
      organizationId: h.tenantA.organizationId,
      metric: 'media_processed_minute',
      limit: 10,
    });

    expect(events.map((event) => event.resourceId)).toContain(resourceId);
  });

  it('excludes a period with no activity rather than reporting zero rows', async () => {
    const summary = await summarizeUsage(db, {
      ...tenancy(),
      from: '2020-01-01',
      to: '2020-01-02',
    });

    expect(summary).toHaveLength(0);
  });
});
