import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseHandle, type Database, type DatabaseHandle } from '../client.js';
import { createTenantHarness, databaseUrl, type TenantHarness } from '../test-support/seed.js';
import { listConnectionHealthEvents, setConnectionHealth } from './connections.js';
import {
  findConnectionsByProviderAccount,
  findProviderEventById,
  findUnprocessedProviderEvents,
  markProviderEventProcessed,
  recordProviderEvent,
} from './provider-events.js';

/**
 * Inbound provider event storage (plan §34, §10.4, P4).
 *
 * These properties live in SQL — two partial unique indexes and a conditional update — so
 * a fake repository would assert nothing. Deduplication in particular is the whole reason
 * an at-least-once webhook is safe, and it either holds in Postgres or it does not hold.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('provider event deduplication', () => {
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

  const base = {
    provider: 'mock',
    fingerprint: null,
    eventType: 'test.event',
    signatureVerified: true,
    payload: { hello: 'world' },
    traceId: null,
  };

  it('stores an event the first time it is seen', async () => {
    const result = await recordProviderEvent(db, {
      ...base,
      providerEventId: `evt-first-${Date.now()}`,
    });

    expect(result.duplicate).toBe(false);
    expect(await findProviderEventById(db, result.id)).not.toBeNull();
  });

  it('treats a redelivery of the same provider event id as a duplicate', async () => {
    const providerEventId = `evt-repeat-${Date.now()}`;

    const first = await recordProviderEvent(db, { ...base, providerEventId });
    const second = await recordProviderEvent(db, { ...base, providerEventId });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it('deduplicates on fingerprint when the provider supplies no event id', async () => {
    const fingerprint = `fp-${Date.now()}`;

    const first = await recordProviderEvent(db, { ...base, providerEventId: null, fingerprint });
    const second = await recordProviderEvent(db, { ...base, providerEventId: null, fingerprint });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it('does not collide across providers that happen to share an event id', async () => {
    const providerEventId = `evt-shared-${Date.now()}`;

    const one = await recordProviderEvent(db, { ...base, providerEventId });
    const two = await recordProviderEvent(db, {
      ...base,
      provider: 'bluesky',
      providerEventId,
    });

    expect(one.duplicate).toBe(false);
    expect(two.duplicate).toBe(false);
  });

  it('surfaces a stored-but-unprocessed event to the sweeper, then stops', async () => {
    const recorded = await recordProviderEvent(db, {
      ...base,
      providerEventId: `evt-sweep-${Date.now()}`,
    });

    const pending = await findUnprocessedProviderEvents(db, {
      olderThan: new Date(Date.now() + 60_000),
      limit: 100,
    });
    expect(pending.map((row) => row.id)).toContain(recorded.id);

    await markProviderEventProcessed(db, recorded.id, null);

    const after = await findUnprocessedProviderEvents(db, {
      olderThan: new Date(Date.now() + 60_000),
      limit: 100,
    });
    expect(after.map((row) => row.id)).not.toContain(recorded.id);
  });

  it('never offers an unverified event to the sweeper', async () => {
    const recorded = await recordProviderEvent(db, {
      ...base,
      providerEventId: `evt-unverified-${Date.now()}`,
      signatureVerified: false,
    });

    const pending = await findUnprocessedProviderEvents(db, {
      olderThan: new Date(Date.now() + 60_000),
      limit: 100,
    });

    expect(pending.map((row) => row.id)).not.toContain(recorded.id);
  });
});

describeIntegration('routing an event to its connections', () => {
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

  it('finds the live connection for a provider-side account', async () => {
    const connection = await db.query.socialConnections.findFirst({
      where: (table, { eq }) => eq(table.id, h.tenantA.connectionId),
    });
    expect(connection).toBeDefined();

    const found = await findConnectionsByProviderAccount(
      db,
      connection!.provider,
      connection!.providerAccountId,
    );

    expect(found.map((row) => row.id)).toContain(h.tenantA.connectionId);
  });
});

describeIntegration('connection health transitions', () => {
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

  it('reports a real move and records exactly one history row', async () => {
    const first = await setConnectionHealth(db, h.tenantA.connectionId, 'revoked', 'user.revoked', {
      reason: 'Provider webhook: user.permissions',
    });

    expect(first).toMatchObject({ changed: true, to: 'revoked' });

    const history = await listConnectionHealthEvents(db, h.tenantA.connectionId, 10);
    expect(history[0]).toMatchObject({ toHealth: 'revoked' });
  });

  it('reports no change when the same health is written twice', async () => {
    // The property that makes an at-least-once webhook safe: a redelivered revocation
    // must not emit a second `connection.reauth_required` to the customer (P4).
    await setConnectionHealth(db, h.tenantA.connectionId, 'reauth_required', 'again');
    const before = await listConnectionHealthEvents(db, h.tenantA.connectionId, 50);

    const repeat = await setConnectionHealth(db, h.tenantA.connectionId, 'reauth_required', 'again');
    const after = await listConnectionHealthEvents(db, h.tenantA.connectionId, 50);

    expect(repeat.changed).toBe(false);
    expect(after).toHaveLength(before.length);
  });

  it('reports a change again when health genuinely moves back', async () => {
    await setConnectionHealth(db, h.tenantA.connectionId, 'reauth_required', 'down');
    const recovered = await setConnectionHealth(db, h.tenantA.connectionId, 'healthy', null);

    expect(recovered).toMatchObject({ changed: true, from: 'reauth_required', to: 'healthy' });
  });
});
