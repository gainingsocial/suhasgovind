import { newUuidV7 } from '@gs/contracts/ids';
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import {
  connectionScopes,
  socialConnections,
  socialCredentials,
  type SocialCredential,
} from '../schema/connections.js';

/**
 * Provider credential storage (plan §7.1, ADR-007).
 *
 * This repository moves ciphertext only. Encryption and decryption happen exclusively in
 * `@gs/crypto`, immediately before a provider call (P9) — a repository that decrypted
 * would put plaintext tokens in every code path that happens to read a connection.
 */

export interface StoredCredential {
  id: string;
  connectionId: string;
  /** Non-null when this credential belongs to one publishable surface, not the whole
   *  connection — a Meta Page access token being the canonical case. */
  destinationId: string | null;
  credentialType: SocialCredential['credentialType'];
  ciphertext: string;
  nonce: string;
  algorithm: string;
  keyVersion: number;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
  /** Denormalized from the connection, so a publish needs one query rather than three. */
  authStrategy: (typeof socialConnections.$inferSelect)['authStrategy'];
  connectionMetadata: Record<string, unknown>;
  grantedScopes: string[];
}

/**
 * Every credential for a connection, with the connection metadata a provider call needs.
 *
 * One query rather than three. This runs on the publish hot path for every target, and a
 * connection with an access token plus a refresh token is the common case, not the
 * exception.
 *
 * Pass `destinationId` when loading credentials for a publish. Where the provider issued
 * a token for that specific surface it wins over the connection-level one, which is the
 * whole point of storing it: a Meta Page token publishes to the Page, and the user token
 * that discovered the Page does not. Connection-level credentials the destination does
 * not override — a refresh token, typically — are still returned, so a refresh does not
 * have to know which kind of connection it is looking at.
 */
export async function findConnectionCredentials(
  db: Database,
  connectionId: string,
  destinationId?: string | null,
): Promise<StoredCredential[]> {
  const all = await db
    .select({
      credential: socialCredentials,
      authStrategy: socialConnections.authStrategy,
      connectionMetadata: socialConnections.metadata,
    })
    .from(socialCredentials)
    .innerJoin(socialConnections, eq(socialConnections.id, socialCredentials.connectionId))
    .where(eq(socialCredentials.connectionId, connectionId));

  // Destination-scoped rows belonging to *other* destinations are never a candidate:
  // returning a sibling Page's token would publish to the wrong Page.
  const candidates = all.filter(
    (row) => row.credential.destinationId === null || row.credential.destinationId === destinationId,
  );

  const overridden = new Set(
    candidates
      .filter((row) => row.credential.destinationId !== null)
      .map((row) => row.credential.credentialType),
  );

  const rows = candidates.filter(
    (row) => row.credential.destinationId !== null || !overridden.has(row.credential.credentialType),
  );

  if (rows.length === 0) return [];

  const scopes = await db
    .select({ scope: connectionScopes.scope })
    .from(connectionScopes)
    .where(and(eq(connectionScopes.connectionId, connectionId), eq(connectionScopes.granted, true)));

  const grantedScopes = scopes.map((s) => s.scope);

  return rows.map((row) => ({
    id: row.credential.id,
    connectionId: row.credential.connectionId,
    destinationId: row.credential.destinationId,
    credentialType: row.credential.credentialType,
    ciphertext: row.credential.ciphertext,
    nonce: row.credential.nonce,
    algorithm: row.credential.algorithm,
    keyVersion: row.credential.keyVersion,
    expiresAt: row.credential.expiresAt,
    refreshExpiresAt: row.credential.refreshExpiresAt,
    authStrategy: row.authStrategy,
    connectionMetadata: row.connectionMetadata,
    grantedScopes,
  }));
}

export interface StoreCredentialInput {
  connectionId: string;
  organizationId: string;
  projectId: string;
  credentialType: SocialCredential['credentialType'];
  ciphertext: string;
  nonce: string;
  algorithm: string;
  keyVersion: number;
  expiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
}

/**
 * Insert or replace a credential.
 *
 * Upsert on `(connection, type)` because re-authorizing the same connection must replace
 * the token rather than accumulate a second one — two access tokens for one connection
 * would leave which is current undefined.
 */
export async function storeCredential(
  tx: Database | Transaction,
  input: StoreCredentialInput,
): Promise<void> {
  await tx
    .insert(socialCredentials)
    .values({
      id: newUuidV7(),
      connectionId: input.connectionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      credentialType: input.credentialType,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      algorithm: input.algorithm,
      keyVersion: input.keyVersion,
      expiresAt: input.expiresAt ?? null,
      refreshExpiresAt: input.refreshExpiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: [socialCredentials.connectionId, socialCredentials.credentialType],
      set: {
        ciphertext: input.ciphertext,
        nonce: input.nonce,
        algorithm: input.algorithm,
        keyVersion: input.keyVersion,
        expiresAt: input.expiresAt ?? null,
        refreshExpiresAt: input.refreshExpiresAt ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Take the refresh lock for a connection.
 *
 * A conditional UPDATE, the same shape as the target lease. Two workers refreshing the
 * same OAuth token concurrently is worse than it sounds: many providers invalidate the
 * old refresh token when a new one is issued, so the slower worker writes a token the
 * provider has already revoked and the connection breaks.
 */
export async function acquireRefreshLock(
  db: Database,
  connectionId: string,
  lockSeconds = 60,
): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + lockSeconds * 1000);

  const rows = await db
    .update(socialConnections)
    .set({ refreshLockedUntil: until, health: 'refreshing', updatedAt: now })
    .where(
      and(
        eq(socialConnections.id, connectionId),
        // Typed helpers, not a raw `sql` template. A raw template binds a JS Date as its
        // `toString()` — "Wed Aug 12 2026 … (India Standard Time)" — which Postgres
        // cannot parse as a timestamptz, so the lock could never be taken at all.
        or(isNull(socialConnections.refreshLockedUntil), lt(socialConnections.refreshLockedUntil, now)),
      ),
    )
    .returning({ id: socialConnections.id });

  return rows.length > 0;
}

export async function releaseRefreshLock(db: Database, connectionId: string): Promise<void> {
  await db
    .update(socialConnections)
    .set({ refreshLockedUntil: null, updatedAt: new Date() })
    .where(eq(socialConnections.id, connectionId));
}

/**
 * Connections whose credentials expire soon.
 *
 * Drives the proactive refresh sweep. Refreshing before expiry rather than on failure
 * matters because the alternative is discovering the problem mid-publish, where the only
 * options are a delayed retry or a failed post.
 */
export interface ExpiringCredential {
  connectionId: string;
  credentialType: SocialCredential['credentialType'];
  expiresAt: Date;
}

export async function findCredentialsNearingExpiry(
  db: Database,
  withinSeconds: number,
  limit = 100,
): Promise<ExpiringCredential[]> {
  const threshold = new Date(Date.now() + withinSeconds * 1000);

  const rows = await db
    .select({
      connectionId: socialCredentials.connectionId,
      credentialType: socialCredentials.credentialType,
      expiresAt: socialCredentials.expiresAt,
    })
    .from(socialCredentials)
    .innerJoin(socialConnections, eq(socialConnections.id, socialCredentials.connectionId))
    .where(
      and(
        lt(socialCredentials.expiresAt, threshold),
        inArray(socialConnections.health, ['healthy', 'refresh_due']),
      ),
    )
    .limit(limit);

  // The WHERE clause already excludes NULLs, but the column type does not know that.
  return rows.filter((row): row is ExpiringCredential => row.expiresAt !== null);
}
