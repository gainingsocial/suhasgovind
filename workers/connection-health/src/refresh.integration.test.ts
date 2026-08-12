import { CredentialCipher, Keyring } from '@gs/crypto';
import {
  createDatabaseHandle,
  findConnectionCredentials,
  findConnectionsDueForRefresh,
  listConnectionHealthEvents,
  schema,
  storeCredential,
  type ConnectionDueForRefresh,
  type Database,
  type DatabaseHandle,
} from '@gs/db';
import { createTenantHarness, databaseUrl, type TenantHarness } from '@gs/db/test-support';
import { createLogger, newTraceContext } from '@gs/observability';
import { mockStore } from '@gs/provider-mock';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Env } from './env.js';
import { refreshConnection } from './refresh.js';

/**
 * Connection health engine (plan §42).
 *
 * The properties under test are all about what happens when automated recovery *cannot*
 * work, because that is where the damage is:
 *
 *  - a concurrent refresh must not rotate twice, since most providers invalidate the old
 *    refresh token when a new one is issued;
 *  - a transient provider failure must not tell the customer to reconnect, because doing
 *    so revokes a token that was fine;
 *  - a genuinely dead credential must tell them exactly once.
 *
 * The lock that guarantees the first is a conditional UPDATE, so this needs a real
 * database.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

const TEST_KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

describeIntegration('connection health: refreshConnection', () => {
  let h: TenantHarness;
  let handle: DatabaseHandle;
  let db: Database;
  let env: Env;

  const logger = createLogger(newTraceContext(), { service: 'test', level: 'error' });

  const cipher = new CredentialCipher(
    Keyring.fromEnv({ CREDENTIAL_KEK_V1: TEST_KEK, CREDENTIAL_KEK_ACTIVE_VERSION: '1' }),
  );

  beforeAll(async () => {
    h = await createTenantHarness([]);
    handle = createDatabaseHandle({ connectionString: h.connectionString, max: 2 });
    db = handle.db;

    env = {
      ENVIRONMENT: 'test',
      SERVICE_VERSION: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: h.connectionString,
      CREDENTIAL_KEK_V1: TEST_KEK,
      CREDENTIAL_KEK_ACTIVE_VERSION: '1',
    };
  });

  afterAll(async () => {
    await handle?.close();
    await h?.cleanup();
  });

  afterEach(() => {
    mockStore.reset();
  });

  /**
   * A connection holding an access token that expires in an hour, plus a refresh token.
   *
   * Written fresh per test rather than once, because a rotation replaces both and later
   * tests must not inherit whatever the previous one left behind.
   */
  async function seedRefreshableCredentials(options: {
    expiresInMs?: number;
    refreshExpiresInMs?: number | null;
  } = {}) {
    const context = {
      organizationId: h.tenantA.organizationId,
      projectId: h.tenantA.projectId,
      connectionId: h.tenantA.connectionId,
    };

    const access = await cipher.encrypt('initial-access-token', {
      ...context,
      credentialType: 'access_token',
    });
    const refresh = await cipher.encrypt('initial-refresh-token', {
      ...context,
      credentialType: 'refresh_token',
    });

    await storeCredential(db, {
      ...context,
      credentialType: 'access_token',
      ciphertext: access.ciphertext,
      nonce: access.nonce,
      algorithm: access.algorithm,
      keyVersion: access.keyVersion,
      expiresAt: new Date(Date.now() + (options.expiresInMs ?? 3_600_000)),
      refreshExpiresAt:
        options.refreshExpiresInMs === undefined
          ? null
          : options.refreshExpiresInMs === null
            ? null
            : new Date(Date.now() + options.refreshExpiresInMs),
    });

    await storeCredential(db, {
      ...context,
      credentialType: 'refresh_token',
      ciphertext: refresh.ciphertext,
      nonce: refresh.nonce,
      algorithm: refresh.algorithm,
      keyVersion: refresh.keyVersion,
    });
  }

  async function clearCredentials() {
    await db
      .delete(schema.socialCredentials)
      .where(eq(schema.socialCredentials.connectionId, h.tenantA.connectionId));
  }

  async function resetConnection() {
    await db
      .update(schema.socialConnections)
      .set({ health: 'healthy', healthDetail: null, refreshLockedUntil: null })
      .where(eq(schema.socialConnections.id, h.tenantA.connectionId));
  }

  /** The row shape the sweep produces, for calling `refreshConnection` directly. */
  async function dueRow(): Promise<ConnectionDueForRefresh> {
    const rows = await findConnectionsDueForRefresh(db, 24 * 3600, 50);
    const row = rows.find((entry) => entry.connectionId === h.tenantA.connectionId);
    if (!row) throw new Error('Expected the seeded connection to be due for refresh.');
    return row;
  }

  beforeEach(async () => {
    await clearCredentials();
    await resetConnection();
  });

  it('finds a connection whose access token expires inside the window', async () => {
    await seedRefreshableCredentials();

    const rows = await findConnectionsDueForRefresh(db, 24 * 3600, 50);
    expect(rows.map((row) => row.connectionId)).toContain(h.tenantA.connectionId);
  });

  it('leaves a credential with plenty of life alone', async () => {
    await seedRefreshableCredentials({ expiresInMs: 30 * 24 * 3_600_000 });

    const rows = await findConnectionsDueForRefresh(db, 24 * 3600, 50);
    expect(rows.map((row) => row.connectionId)).not.toContain(h.tenantA.connectionId);
  });

  it('rotates the stored credentials and returns the connection to healthy', async () => {
    await seedRefreshableCredentials();
    const row = await dueRow();
    mockStore.setBehaviour({ refresh: 'rotate' });

    expect(await refreshConnection(db, env, row, logger)).toBe('refreshed');

    const stored = await findConnectionCredentials(db, h.tenantA.connectionId);
    const access = stored.find((entry) => entry.credentialType === 'access_token')!;
    const refresh = stored.find((entry) => entry.credentialType === 'refresh_token')!;

    const decrypt = (entry: typeof access, credentialType: string) =>
      cipher.decrypt(
        {
          ciphertext: entry.ciphertext,
          nonce: entry.nonce,
          algorithm: entry.algorithm as 'AES-256-GCM',
          keyVersion: entry.keyVersion,
        },
        {
          organizationId: h.tenantA.organizationId,
          projectId: h.tenantA.projectId,
          connectionId: h.tenantA.connectionId,
          credentialType,
          destinationId: entry.destinationId,
        },
      );

    // Both halves replaced. A provider that rotates has already invalidated the old pair,
    // so writing one without the other leaves a connection that can never refresh again.
    expect(await decrypt(access, 'access_token')).toBe('mock_access_1');
    expect(await decrypt(refresh, 'refresh_token')).toBe('mock_refresh_1');

    const connection = await db.query.socialConnections.findFirst({
      where: (table, { eq: is }) => is(table.id, h.tenantA.connectionId),
    });
    expect(connection?.health).toBe('healthy');
    // The lock is always released, including on the happy path.
    expect(connection?.refreshLockedUntil).toBeNull();
  });

  it('rotates exactly once when two workers race the same connection', async () => {
    // The property the whole lock exists for. Most OAuth providers invalidate the old
    // refresh token when a new one is issued, so a second rotation does not duplicate
    // work — it writes a token the provider has already revoked, and the connection dies.
    await seedRefreshableCredentials();
    const row = await dueRow();
    mockStore.setBehaviour({ refresh: 'rotate' });

    const [a, b] = await Promise.all([
      refreshConnection(db, env, row, logger),
      refreshConnection(db, env, row, logger),
    ]);

    expect([a, b].filter((outcome) => outcome === 'refreshed')).toHaveLength(1);
    expect([a, b].filter((outcome) => outcome === 'locked')).toHaveLength(1);
    expect(mockStore.rotationCount()).toBe(1);
  });

  it('skips the write when the provider says the credential is still valid', async () => {
    await seedRefreshableCredentials();
    const row = await dueRow();
    mockStore.setBehaviour({ refresh: 'no_op' });

    expect(await refreshConnection(db, env, row, logger)).toBe('still_valid');
    expect(mockStore.rotationCount()).toBe(0);
  });

  it('defers a transient provider failure instead of blaming the customer', async () => {
    // Telling somebody to reconnect a working account is destructive: once they do, the
    // old token really is revoked. A 503 is the provider having a bad minute.
    await seedRefreshableCredentials();
    const row = await dueRow();
    mockStore.setBehaviour({ refresh: 'unavailable' });

    expect(await refreshConnection(db, env, row, logger)).toBe('deferred');

    const connection = await db.query.socialConnections.findFirst({
      where: (table, { eq: is }) => is(table.id, h.tenantA.connectionId),
    });
    expect(connection?.health).toBe('refresh_due');
    expect(connection?.refreshLockedUntil).toBeNull();
  });

  it('escalates an expired refresh token to reauth_required', async () => {
    await seedRefreshableCredentials();
    const row = await dueRow();
    mockStore.setBehaviour({ refresh: 'expired' });

    expect(await refreshConnection(db, env, row, logger)).toBe('reauth_required');

    const connection = await db.query.socialConnections.findFirst({
      where: (table, { eq: is }) => is(table.id, h.tenantA.connectionId),
    });
    expect(connection?.health).toBe('reauth_required');
  });

  it('escalates a revoked grant to reauth_required', async () => {
    await seedRefreshableCredentials();
    const row = await dueRow();
    mockStore.setBehaviour({ refresh: 'revoked' });

    expect(await refreshConnection(db, env, row, logger)).toBe('reauth_required');
  });

  it('emits connection.reauth_required exactly once, however many sweeps run', async () => {
    // An alert that fires on every sweep of an already-broken connection gets muted, and
    // the next real one is then missed.
    await seedRefreshableCredentials();
    mockStore.setBehaviour({ refresh: 'expired' });

    const first = await dueRow();
    await refreshConnection(db, env, first, logger);

    const events = await db
      .select()
      .from(schema.outboundWebhookEvents)
      .where(eq(schema.outboundWebhookEvents.aggregateId, h.tenantA.connectionId));

    expect(events.filter((e) => e.eventType === 'connection.reauth_required')).toHaveLength(1);

    // A second sweep would not even select it — `reauth_required` is excluded from the
    // due query, which is what stops a dead connection being retried forever.
    const stillDue = await findConnectionsDueForRefresh(db, 24 * 3600, 50);
    expect(stillDue.map((row) => row.connectionId)).not.toContain(h.tenantA.connectionId);
  });

  it('records the health transition in the connection’s history', async () => {
    await seedRefreshableCredentials();
    const row = await dueRow();
    mockStore.setBehaviour({ refresh: 'expired' });

    await refreshConnection(db, env, row, logger);

    const history = await listConnectionHealthEvents(db, h.tenantA.connectionId, 10);
    expect(history[0]).toMatchObject({ toHealth: 'reauth_required' });
  });

  it('does not call the provider at all when the refresh token has itself expired', async () => {
    // The answer is already known, so a network call would be a guaranteed failure on
    // every sweep, for every affected connection, forever.
    await seedRefreshableCredentials({ refreshExpiresInMs: -1_000 });
    const row = await dueRow();
    mockStore.setBehaviour({ refresh: 'rotate' });

    expect(await refreshConnection(db, env, row, logger)).toBe('reauth_required');
    expect(mockStore.rotationCount()).toBe(0);
  });

  it('reports refresh_due rather than failing when no refresh token is stored', async () => {
    // A credential that expires with no way to renew it will stop working on a known date.
    // That is not an error today, and it is worth saying before the date arrives.
    const context = {
      organizationId: h.tenantA.organizationId,
      projectId: h.tenantA.projectId,
      connectionId: h.tenantA.connectionId,
    };
    const access = await cipher.encrypt('lonely-access-token', {
      ...context,
      credentialType: 'access_token',
    });

    await storeCredential(db, {
      ...context,
      credentialType: 'access_token',
      ciphertext: access.ciphertext,
      nonce: access.nonce,
      algorithm: access.algorithm,
      keyVersion: access.keyVersion,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const row = await dueRow();
    expect(await refreshConnection(db, env, row, logger)).toBe('not_refreshable');

    const connection = await db.query.socialConnections.findFirst({
      where: (table, { eq: is }) => is(table.id, h.tenantA.connectionId),
    });
    expect(connection?.health).toBe('refresh_due');
  });
});
