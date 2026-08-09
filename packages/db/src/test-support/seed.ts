import { newUuidV7, toPublicId } from '@gs/contracts/ids';
import type { ApiScope } from '@gs/contracts/scopes';
import { generateApiKey } from '@gs/crypto';
import { eq, inArray } from 'drizzle-orm';

import { createDatabaseHandle, type DatabaseHandle } from '../client.js';
import * as schema from '../schema/index.js';

/**
 * Integration fixtures for tenant-isolation tests (plan P5, Rule 5).
 *
 * Lives in `@gs/db` rather than in the API app because seeding needs the Drizzle schema,
 * and `pnpm boundaries` correctly forbids `apps/**` from importing a SQL driver. Test
 * scaffolding does not get an exemption from the layering rules — it gets placed
 * correctly instead.
 *
 * An ownership test without a real database is not an ownership test: the isolation being
 * verified lives in WHERE clauses and foreign keys, which a fake repository would not
 * have. Each harness seeds two complete, unrelated tenants — two rather than one, because
 * a single-tenant test passes even when the environment filter is missing entirely.
 */

export const TEST_PEPPER = 'integration-test-pepper-not-a-real-secret';

export interface SeededTenant {
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  /** Raw API key with the harness's default scopes. Only ever in memory. */
  apiKey: string;
  apiKeyId: string;
  profileId: string;
  publicProfileId: string;
  /** A healthy `mock` connection, so publishing paths have something to resolve. */
  connectionId: string;
  publicConnectionId: string;
  destinationId: string;
  publicDestinationId: string;
  providerDestinationId: string;
}

export interface TenantHarness {
  handle: DatabaseHandle;
  pepper: string;
  connectionString: string;
  tenantA: SeededTenant;
  tenantB: SeededTenant;
  /**
   * Mint an additional key against an existing tenant.
   *
   * Scope and restriction tests need a differently-configured key, not a whole second
   * organization. Seeding an org costs six sequential round trips to a remote database;
   * a key costs two. Over a suite that difference is minutes.
   */
  issueKey: (
    tenant: SeededTenant,
    scopes: readonly ApiScope[],
    options?: { restrictToProfileId?: string },
  ) => Promise<string>;
  cleanup: () => Promise<void>;
}

/**
 * Absent DATABASE_URL means the integration suite skips rather than fails.
 *
 * Reached through `globalThis` rather than the bare `process` global on purpose. Every
 * package here compiles against the Workers runtime types only (see `tsconfig.base.json`),
 * which is what stops production code accidentally depending on Node built-ins. This is
 * test scaffolding that genuinely runs under Node, and this is the narrowest way to say
 * so without loosening the type surface for everything else.
 */
export function databaseUrl(): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.DATABASE_URL;
}

/**
 * Collision-resistant suffix.
 *
 * Deliberately not `newUuidV7().slice(0, 8)`: a UUIDv7 begins with a millisecond
 * timestamp, so two fixtures created in the same millisecond produce the *same* prefix
 * and violate the org slug's unique constraint. Random bytes have no such structure.
 */
function suffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

interface KeyRow {
  id: string;
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  status: 'active';
  restrictedToProfileId: string | null;
}

async function buildKey(
  tenant: { organizationId: string; projectId: string; projectEnvironmentId: string },
  scopes: readonly ApiScope[],
  restrictedToProfileId: string | null,
): Promise<{ raw: string; row: KeyRow; scopeRows: { id: string; apiKeyId: string; scope: string }[] }> {
  const generated = await generateApiKey('test', TEST_PEPPER);
  const id = newUuidV7();

  return {
    raw: generated.raw,
    row: {
      id,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      projectEnvironmentId: tenant.projectEnvironmentId,
      name: `IT key ${suffix()}`,
      keyPrefix: generated.prefix,
      keyHash: generated.hash,
      status: 'active',
      restrictedToProfileId,
    },
    scopeRows: scopes.map((scope) => ({ id: newUuidV7(), apiKeyId: id, scope })),
  };
}

export async function createTenantHarness(
  scopes: readonly ApiScope[],
  options: { restrictTenantBToProfile?: boolean } = {},
): Promise<TenantHarness> {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error('DATABASE_URL is required for integration tests.');

  const handle = createDatabaseHandle({ connectionString, max: 4 });
  const { db } = handle;

  const build = (label: string) => {
    const s = suffix();
    return {
      label,
      s,
      organizationId: newUuidV7(),
      projectId: newUuidV7(),
      projectEnvironmentId: newUuidV7(),
      profileId: newUuidV7(),
      connectionId: newUuidV7(),
      destinationId: newUuidV7(),
      providerDestinationId: `mock_dst_${s}`,
    };
  };

  const a = build('a');
  const b = build('b');

  // Batched by table rather than one tenant at a time. Insert order still respects the
  // foreign keys, but each level costs one round trip for both tenants instead of two.
  await db.insert(schema.organizations).values(
    [a, b].map((t) => ({ id: t.organizationId, name: `IT ${t.label} ${t.s}`, slug: `it-${t.label}-${t.s}` })),
  );

  await db.insert(schema.projects).values(
    [a, b].map((t) => ({
      id: t.projectId,
      organizationId: t.organizationId,
      name: `IT project ${t.s}`,
      slug: `it-project-${t.s}`,
    })),
  );

  await db.insert(schema.projectEnvironments).values(
    [a, b].map((t) => ({
      id: t.projectEnvironmentId,
      projectId: t.projectId,
      organizationId: t.organizationId,
      kind: 'test' as const,
      simulationMode: true,
    })),
  );

  await db.insert(schema.profiles).values(
    [a, b].map((t) => ({
      id: t.profileId,
      projectEnvironmentId: t.projectEnvironmentId,
      projectId: t.projectId,
      organizationId: t.organizationId,
      name: `IT profile ${t.s}`,
      timezone: 'UTC',
    })),
  );

  // A healthy `mock` connection and destination per tenant, so publishing and capability
  // paths have something real to resolve. Seeded here rather than per-suite because every
  // route beyond profiles needs one, and the ownership chain
  // (destination → connection → profile → environment → project) only exists if all of it
  // is present.
  await db.insert(schema.socialConnections).values(
    [a, b].map((t) => ({
      id: t.connectionId,
      profileId: t.profileId,
      projectEnvironmentId: t.projectEnvironmentId,
      projectId: t.projectId,
      organizationId: t.organizationId,
      provider: 'mock',
      authStrategy: 'api_key' as const,
      providerAccountId: `mock_account_${t.s}`,
      providerAccountName: 'Mock Account',
      providerAccountHandle: '@mock',
      health: 'healthy' as const,
      setupCompletedAt: new Date(),
    })),
  );

  await db.insert(schema.connectionScopes).values(
    [a, b].flatMap((t) =>
      ['post.write', 'post.read', 'destination.read'].map((scope) => ({
        id: newUuidV7(),
        connectionId: t.connectionId,
        scope,
        granted: true,
      })),
    ),
  );

  await db.insert(schema.socialDestinations).values(
    [a, b].map((t) => ({
      id: t.destinationId,
      connectionId: t.connectionId,
      profileId: t.profileId,
      projectEnvironmentId: t.projectEnvironmentId,
      organizationId: t.organizationId,
      provider: 'mock',
      providerDestinationId: t.providerDestinationId,
      destinationType: 'feed',
      name: `Mock feed ${t.s}`,
      handle: '@mock',
      selected: true,
    })),
  );

  const keyA = await buildKey(a, scopes, null);
  const keyB = await buildKey(b, scopes, options.restrictTenantBToProfile ? b.profileId : null);

  await db.insert(schema.apiKeys).values([keyA.row, keyB.row]);
  const allScopeRows = [...keyA.scopeRows, ...keyB.scopeRows];
  if (allScopeRows.length > 0) {
    await db.insert(schema.apiKeyScopes).values(allScopeRows);
  }

  const toTenant = (t: ReturnType<typeof build>, raw: string, keyId: string): SeededTenant => ({
    organizationId: t.organizationId,
    projectId: t.projectId,
    projectEnvironmentId: t.projectEnvironmentId,
    apiKey: raw,
    apiKeyId: keyId,
    profileId: t.profileId,
    publicProfileId: toPublicId('profile', t.profileId),
    connectionId: t.connectionId,
    publicConnectionId: toPublicId('connection', t.connectionId),
    destinationId: t.destinationId,
    publicDestinationId: toPublicId('destination', t.destinationId),
    providerDestinationId: t.providerDestinationId,
  });

  return {
    handle,
    pepper: TEST_PEPPER,
    connectionString,
    tenantA: toTenant(a, keyA.raw, keyA.row.id),
    tenantB: toTenant(b, keyB.raw, keyB.row.id),

    issueKey: async (tenant, keyScopes, keyOptions = {}) => {
      const built = await buildKey(tenant, keyScopes, keyOptions.restrictToProfileId ?? null);
      await db.insert(schema.apiKeys).values(built.row);
      if (built.scopeRows.length > 0) {
        await db.insert(schema.apiKeyScopes).values(built.scopeRows);
      }
      return built.raw;
    },

    cleanup: async () => {
      // Only the organizations; everything else cascades, which is exactly what the
      // schema's `onDelete: 'cascade'` foreign keys exist to provide.
      await db
        .delete(schema.organizations)
        .where(inArray(schema.organizations.id, [a.organizationId, b.organizationId]));
      await handle.close();
    },
  };
}

/** Narrow helper for suites that need to assert on a single organization's rows. */
export async function deleteOrganization(handle: DatabaseHandle, organizationId: string): Promise<void> {
  await handle.db.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
}
