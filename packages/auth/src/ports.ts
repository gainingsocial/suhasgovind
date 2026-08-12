import type { ApiScope } from '@gs/contracts/scopes';

/**
 * What the auth layer needs from storage, expressed as a domain operation rather than as
 * CRUD (plan §76). `@gs/db` supplies the implementation; this package never imports it,
 * which is what keeps authentication testable without a database and keeps the SQL driver
 * out of the Worker bundle.
 */

/** The stored key, as far as authentication is concerned. */
export interface ApiKeyRecord {
  id: string;
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  environment: 'test' | 'live';
  /** Environment execution mode (plan §49), carried on the key's own environment join. */
  simulationMode: boolean;
  keyHash: string;
  status: 'active' | 'revoked' | 'expired';
  scopes: readonly ApiScope[];
  restrictedToProfileId: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface ApiKeyRepository {
  /**
   * Look up by hash — a single indexed equality lookup, never a scan comparing candidate
   * hashes, which would put a timing side channel in the database layer
   * (see `@gs/crypto` `verifyApiKey`).
   */
  findByHash: (keyHash: string) => Promise<ApiKeyRecord | null>;

  /**
   * Record use. Deliberately separate from the lookup and never awaited on the request
   * path (plan §90) — a write on every authenticated call would serialize the hot path
   * behind the database.
   */
  touchLastUsed: (apiKeyId: string, at: Date) => Promise<void>;
}
