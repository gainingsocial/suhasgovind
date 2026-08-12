import { like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseHandle, type Database, type DatabaseHandle } from '../client.js';
import { featureFlags } from '../schema/platform.js';
import { createTenantHarness, databaseUrl, type TenantHarness } from '../test-support/seed.js';
import {
  findEnvironmentSettings,
  providerBlockedBy,
  resolveFlags,
  setSimulationMode,
  upsertFeatureFlag,
} from './environment-settings.js';

/**
 * Feature-flag scope precedence and environment mode (plan §45, §49).
 *
 * Precedence is decided by a real query over a real unique constraint, so it belongs in
 * the integration suite. The decision logic itself is unit-tested in
 * `feature-flags.test.ts`.
 */

const describeIntegration = databaseUrl() ? describe : describe.skip;

describeIntegration('feature flag scope precedence', () => {
  let h: TenantHarness;
  let handle: DatabaseHandle;
  let db: Database;

  /**
   * A key that belongs to no real provider, unique per run.
   *
   * Global flags are the one thing here that outlive `cleanup()` — they belong to no
   * tenant, so nothing cascades them away. Writing `provider:mock` at global scope in an
   * earlier version of this file left a kill switch on for every suite that ran
   * afterwards, and turned the publisher's entire integration suite red with
   * `PROVIDER_TEMPORARILY_DISABLED`. A synthetic key cannot do that even if cleanup fails.
   */
  const KEY = `provider:it_${Date.now().toString(36)}`;

  beforeAll(async () => {
    h = await createTenantHarness([]);
    handle = createDatabaseHandle({ connectionString: h.connectionString, max: 2 });
    db = handle.db;
  });

  afterAll(async () => {
    // Belt as well as braces: delete every row this file created, at every scope.
    await db?.delete(featureFlags).where(like(featureFlags.key, 'provider:it_%'));
    await handle?.close();
    await h?.cleanup();
  });

  const scopeA = () => ({
    organizationId: h.tenantA.organizationId,
    projectId: h.tenantA.projectId,
    projectEnvironmentId: h.tenantA.projectEnvironmentId,
  });

  it('applies a global flag to everyone', async () => {
    await upsertFeatureFlag(db, { key: KEY, enabled: false });

    const flags = await resolveFlags(db, scopeA());
    expect(providerBlockedBy(flags, KEY.slice('provider:'.length))).toMatchObject({ decidedBy: 'global' });
  });

  it('lets an organization override the global default', async () => {
    await upsertFeatureFlag(db, { key: KEY, enabled: false });
    await upsertFeatureFlag(db, {
      key: KEY,
      enabled: true,
      organizationId: h.tenantA.organizationId,
    });

    const flags = await resolveFlags(db, scopeA());
    expect(providerBlockedBy(flags, KEY.slice('provider:'.length))).toBeNull();
    expect(flags.get(KEY)?.decidedBy).toBe('organization');
  });

  it('lets an environment override its organization', async () => {
    await upsertFeatureFlag(db, {
      key: KEY,
      enabled: true,
      organizationId: h.tenantA.organizationId,
    });
    await upsertFeatureFlag(db, {
      key: KEY,
      enabled: false,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
    });

    const flags = await resolveFlags(db, scopeA());
    expect(flags.get(KEY)?.decidedBy).toBe('environment');
    expect(providerBlockedBy(flags, KEY.slice('provider:'.length))).toMatchObject({ decidedBy: 'environment' });
  });

  it('never leaks one tenant’s flag into another’s resolution', async () => {
    // The property that makes a per-customer kill switch safe: switching a provider off
    // for one customer during an incident must not switch it off for everybody.
    await upsertFeatureFlag(db, {
      key: `${KEY}_leak`,
      enabled: false,
      organizationId: h.tenantA.organizationId,
    });

    const other = await resolveFlags(db, {
      organizationId: h.tenantB.organizationId,
      projectId: h.tenantB.projectId,
      projectEnvironmentId: h.tenantB.projectEnvironmentId,
    });

    expect(other.get(`${KEY}_leak`)).toBeUndefined();
    expect(providerBlockedBy(other, `${KEY.slice('provider:'.length)}_leak`)).toBeNull();
  });

  it('updates an existing flag in place rather than stacking rows', async () => {
    await upsertFeatureFlag(db, {
      key: `${KEY}_toggle`,
      enabled: false,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
    });
    await upsertFeatureFlag(db, {
      key: `${KEY}_toggle`,
      enabled: true,
      projectEnvironmentId: h.tenantA.projectEnvironmentId,
    });

    const flags = await resolveFlags(db, scopeA());
    expect(flags.get(`${KEY}_toggle`)?.enabled).toBe(true);
  });
});

describeIntegration('environment execution mode', () => {
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

  it('reads back the mode that was written', async () => {
    await setSimulationMode(db, h.tenantA.projectEnvironmentId, true);
    expect(
      (await findEnvironmentSettings(db, h.tenantA.projectEnvironmentId))?.simulationMode,
    ).toBe(true);

    await setSimulationMode(db, h.tenantA.projectEnvironmentId, false);
    expect(
      (await findEnvironmentSettings(db, h.tenantA.projectEnvironmentId))?.simulationMode,
    ).toBe(false);
  });

  it('switches one environment without touching another tenant’s', async () => {
    await setSimulationMode(db, h.tenantA.projectEnvironmentId, false);
    await setSimulationMode(db, h.tenantB.projectEnvironmentId, true);

    await setSimulationMode(db, h.tenantA.projectEnvironmentId, true);
    expect(
      (await findEnvironmentSettings(db, h.tenantB.projectEnvironmentId))?.simulationMode,
    ).toBe(true);

    await setSimulationMode(db, h.tenantB.projectEnvironmentId, false);
    expect(
      (await findEnvironmentSettings(db, h.tenantA.projectEnvironmentId))?.simulationMode,
    ).toBe(true);
  });

  it('returns null for an environment that does not exist', async () => {
    // The publisher treats null as live. Defaulting the other way would mean a race
    // between a deletion and an in-flight publish silently stopped a real post.
    expect(
      await findEnvironmentSettings(db, '00000000-0000-7000-8000-000000000000'),
    ).toBeNull();
  });
});
