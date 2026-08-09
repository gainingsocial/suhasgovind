import { newUuidV7 } from '@gs/contracts/ids';
import type { ApiScope } from '@gs/contracts/scopes';
import { ApiError } from '@gs/errors';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import { apiKeyScopes, apiKeys, type ApiKey } from '../schema/api-keys.js';
import { organizationMembers, projectEnvironments } from '../schema/tenancy.js';

/**
 * API key administration (plan §38, §39).
 *
 * Separate from `api-keys.ts`, which serves authentication on the request hot path. These
 * are the human-facing operations: a person with an organization role creating, listing
 * and revoking keys from the dashboard.
 *
 * The distinction matters because the authorization model is different. Authentication
 * resolves a key to a project. These functions resolve a *person* to an organization role
 * — and a person may not mint a key for an organization they do not belong to.
 */

export interface MembershipContext {
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  environment: 'test' | 'live';
  role: string;
}

/**
 * Resolve what a human may do in one environment.
 *
 * Returns null rather than throwing when the person is not a member, so the caller can
 * decide whether that is a 403 or a 404 — and both leak the same single bit, so the
 * choice is about clarity rather than security.
 */
export async function findMembershipForEnvironment(
  db: Database,
  userId: string,
  projectEnvironmentId: string,
): Promise<MembershipContext | null> {
  const rows = await db
    .select({
      organizationId: projectEnvironments.organizationId,
      projectId: projectEnvironments.projectId,
      projectEnvironmentId: projectEnvironments.id,
      environment: projectEnvironments.kind,
      role: organizationMembers.role,
    })
    .from(projectEnvironments)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, projectEnvironments.organizationId),
        eq(organizationMembers.userId, userId),
        // An invitation that was never accepted is not membership. Expressed in the join
        // rather than the WHERE clause so a pending invite yields no row at all, instead
        // of a row the caller has to remember to filter.
        isNotNull(organizationMembers.acceptedAt),
      ),
    )
    .where(eq(projectEnvironments.id, projectEnvironmentId))
    .limit(1);

  return rows[0] ?? null;
}

/** Environments a person can see, for the dashboard's project switcher. */
export async function listEnvironmentsForUser(
  db: Database,
  userId: string,
): Promise<MembershipContext[]> {
  return db
    .select({
      organizationId: projectEnvironments.organizationId,
      projectId: projectEnvironments.projectId,
      projectEnvironmentId: projectEnvironments.id,
      environment: projectEnvironments.kind,
      role: organizationMembers.role,
    })
    .from(projectEnvironments)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, projectEnvironments.organizationId),
        eq(organizationMembers.userId, userId),
        isNotNull(organizationMembers.acceptedAt),
      ),
    )
    .orderBy(desc(projectEnvironments.createdAt));
}

export interface CreateApiKeyInput {
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: readonly ApiScope[];
  restrictedToProfileId: string | null;
  expiresAt: Date | null;
  createdByUserId: string;
}

/**
 * Store a newly minted key.
 *
 * Only the hash is written. The raw value is returned to the caller once and never
 * persisted — that is what makes a database dump useless for authenticating (plan §38).
 */
export async function createApiKey(
  db: Database,
  input: CreateApiKeyInput,
): Promise<ApiKey> {
  return db.transaction(async (tx: Transaction) => {
    const id = newUuidV7();

    const rows = await tx
      .insert(apiKeys)
      .values({
        id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        projectEnvironmentId: input.projectEnvironmentId,
        name: input.name,
        keyPrefix: input.keyPrefix,
        keyHash: input.keyHash,
        status: 'active',
        restrictedToProfileId: input.restrictedToProfileId,
        expiresAt: input.expiresAt,
        createdByUserId: input.createdByUserId,
      })
      .returning();

    const created = rows[0];
    if (!created) throw new ApiError('INTERNAL_ERROR', { message: 'API key insert returned no row.' });

    if (input.scopes.length > 0) {
      await tx
        .insert(apiKeyScopes)
        .values(input.scopes.map((scope) => ({ id: newUuidV7(), apiKeyId: id, scope })));
    }

    return created;
  });
}

export interface ApiKeySummary extends ApiKey {
  scopes: string[];
}

export async function listApiKeys(
  db: Database,
  projectEnvironmentId: string,
): Promise<ApiKeySummary[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.projectEnvironmentId, projectEnvironmentId))
    .orderBy(desc(apiKeys.id));

  if (rows.length === 0) return [];

  // Scoped to this environment's keys. Without the filter this reads every scope row in
  // the table — every tenant's — and returns more the busier the platform gets.
  const scopes = await db
    .select({ apiKeyId: apiKeyScopes.apiKeyId, scope: apiKeyScopes.scope })
    .from(apiKeyScopes)
    .where(
      inArray(
        apiKeyScopes.apiKeyId,
        rows.map((row) => row.id),
      ),
    );

  const byKey = new Map<string, string[]>();
  for (const row of scopes) {
    byKey.set(row.apiKeyId, [...(byKey.get(row.apiKeyId) ?? []), row.scope]);
  }

  return rows.map((row) => ({ ...row, scopes: byKey.get(row.id) ?? [] }));
}

/**
 * Revoke a key.
 *
 * Immediate and irreversible — authentication reads `status` on every request, so a
 * revoked key stops working on the next call rather than at some expiry. Revoking an
 * already-revoked key reports false so the route can 404 rather than implying it did
 * something.
 */
export async function revokeApiKey(
  db: Database,
  projectEnvironmentId: string,
  apiKeyId: string,
): Promise<boolean> {
  const now = new Date();

  const rows = await db
    .update(apiKeys)
    .set({ status: 'revoked', revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(apiKeys.id, apiKeyId),
        eq(apiKeys.projectEnvironmentId, projectEnvironmentId),
        eq(apiKeys.status, 'active'),
      ),
    )
    .returning({ id: apiKeys.id });

  return rows.length > 0;
}
