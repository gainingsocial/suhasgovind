import type { ApiKeyRecord, ApiKeyRepository } from '@gs/auth';
import { type ApiScope, isApiScope } from '@gs/contracts/scopes';
import { eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import { apiKeyScopes, apiKeys } from '../schema/api-keys.js';
import { projectEnvironments } from '../schema/tenancy.js';

/**
 * API key lookup for authentication (plan §38).
 *
 * One indexed equality lookup on the unique `key_hash`, joined to the environment for its
 * test/live kind. Never a scan over candidate rows comparing hashes — that would put a
 * timing side channel in the database layer (see `@gs/crypto` `verifyApiKey`).
 */

export async function findApiKeyByHash(db: Database, keyHash: string): Promise<ApiKeyRecord | null> {
  const rows = await db
    .select({
      id: apiKeys.id,
      organizationId: apiKeys.organizationId,
      projectId: apiKeys.projectId,
      projectEnvironmentId: apiKeys.projectEnvironmentId,
      environmentKind: projectEnvironments.kind,
      keyHash: apiKeys.keyHash,
      status: apiKeys.status,
      restrictedToProfileId: apiKeys.restrictedToProfileId,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .innerJoin(projectEnvironments, eq(projectEnvironments.id, apiKeys.projectEnvironmentId))
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Separate query rather than a join: joining would multiply the key row by its scopes
  // and force a de-duplicating GROUP BY for no benefit at this cardinality.
  const granted = await db
    .select({ scope: apiKeyScopes.scope })
    .from(apiKeyScopes)
    .where(eq(apiKeyScopes.apiKeyId, row.id));

  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    projectEnvironmentId: row.projectEnvironmentId,
    environment: row.environmentKind,
    keyHash: row.keyHash,
    status: row.status,
    // Scopes are stored as free text so a grant survives a rename; anything the current
    // build does not recognize is dropped rather than trusted.
    scopes: granted.map((entry) => entry.scope).filter((scope): scope is ApiScope => isApiScope(scope)),
    restrictedToProfileId: row.restrictedToProfileId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

/** Opportunistic telemetry write. Never awaited on the request path (plan §90). */
export async function touchApiKeyLastUsed(
  db: Database,
  apiKeyId: string,
  at: Date,
): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, apiKeyId));
}

/** Bind the functions above to a connection, producing the port `@gs/auth` consumes. */
export function createApiKeyRepository(db: Database): ApiKeyRepository {
  return {
    findByHash: (keyHash) => findApiKeyByHash(db, keyHash),
    touchLastUsed: (apiKeyId, at) => touchApiKeyLastUsed(db, apiKeyId, at),
  };
}
