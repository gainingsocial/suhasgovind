import { newUuidV7 } from '@gs/contracts/ids';
import { and, asc, desc, eq, gt, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import {
  connectionScopes,
  socialConnections,
  socialCredentials,
  socialDestinations,
  type SocialConnection,
  type SocialCredential,
  type SocialDestination,
} from '../schema/connections.js';
import { profiles } from '../schema/tenancy.js';

/**
 * Connection and destination repository (plan §76).
 *
 * The ownership resolution here is the one plan P5 names explicitly:
 * `destination → connection → profile → environment → project`. It is a single joined
 * query rather than a chain of lookups, because four sequential round trips on the hot
 * path of every publish is both slow and easy to short-circuit incorrectly.
 */

export interface ConnectionWithScopes extends SocialConnection {
  grantedScopes: string[];
}

export interface ListConnectionsInput {
  projectEnvironmentId: string;
  limit: number;
  order: 'asc' | 'desc';
  cursor?: string;
  profileId?: string;
  provider?: string;
  health?: SocialConnection['health'];
  includeDisconnected: boolean;
  restrictedToProfileId?: string | null;
}

/** Scopes for several connections in one query, so a list endpoint is not N+1. */
async function scopesFor(db: Database, connectionIds: string[]): Promise<Map<string, string[]>> {
  const byConnection = new Map<string, string[]>();
  if (connectionIds.length === 0) return byConnection;

  const rows = await db
    .select({ connectionId: connectionScopes.connectionId, scope: connectionScopes.scope })
    .from(connectionScopes)
    .where(
      and(inArray(connectionScopes.connectionId, connectionIds), eq(connectionScopes.granted, true)),
    );

  for (const row of rows) {
    byConnection.set(row.connectionId, [...(byConnection.get(row.connectionId) ?? []), row.scope]);
  }
  return byConnection;
}

export async function listConnections(
  db: Database,
  input: ListConnectionsInput,
): Promise<{ rows: ConnectionWithScopes[]; hasMore: boolean }> {
  const conditions = [eq(socialConnections.projectEnvironmentId, input.projectEnvironmentId)];

  if (!input.includeDisconnected) {
    conditions.push(isNull(socialConnections.disconnectedAt));
  }
  if (input.profileId) conditions.push(eq(socialConnections.profileId, input.profileId));
  if (input.provider) conditions.push(eq(socialConnections.provider, input.provider));
  if (input.health) conditions.push(eq(socialConnections.health, input.health));

  // Enforced in SQL so a route cannot forget it (plan §38).
  if (input.restrictedToProfileId != null) {
    conditions.push(eq(socialConnections.profileId, input.restrictedToProfileId));
  }
  if (input.cursor) {
    conditions.push(
      input.order === 'desc'
        ? lt(socialConnections.id, input.cursor)
        : gt(socialConnections.id, input.cursor),
    );
  }

  const rows = await db
    .select()
    .from(socialConnections)
    .where(and(...conditions))
    .orderBy(input.order === 'desc' ? desc(socialConnections.id) : asc(socialConnections.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const scopes = await scopesFor(db, page.map((row) => row.id));

  return {
    rows: page.map((row) => ({ ...row, grantedScopes: scopes.get(row.id) ?? [] })),
    hasMore,
  };
}

export async function findConnectionById(
  db: Database,
  projectEnvironmentId: string,
  connectionId: string,
): Promise<ConnectionWithScopes | null> {
  const rows = await db
    .select()
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.id, connectionId),
        eq(socialConnections.projectEnvironmentId, projectEnvironmentId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const scopes = await scopesFor(db, [row.id]);
  return { ...row, grantedScopes: scopes.get(row.id) ?? [] };
}

/**
 * Mark a connection disconnected.
 *
 * Soft, like every other delete here. The partial unique index on
 * `(profile, provider, provider_account)` only covers rows where `disconnected_at IS
 * NULL`, so disconnecting frees the slot and a later reconnect of the same account
 * updates cleanly instead of colliding.
 */
export async function disconnectConnection(
  db: Database,
  projectEnvironmentId: string,
  connectionId: string,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(socialConnections)
    .set({ disconnectedAt: now, health: 'disconnected', updatedAt: now })
    .where(
      and(
        eq(socialConnections.id, connectionId),
        eq(socialConnections.projectEnvironmentId, projectEnvironmentId),
        isNull(socialConnections.disconnectedAt),
      ),
    )
    .returning({ id: socialConnections.id });

  return rows.length > 0;
}

export async function listDestinationsForConnection(
  db: Database,
  projectEnvironmentId: string,
  connectionId: string,
  options: { includeRemoved?: boolean } = {},
): Promise<SocialDestination[]> {
  const conditions = [
    eq(socialDestinations.connectionId, connectionId),
    eq(socialDestinations.projectEnvironmentId, projectEnvironmentId),
  ];
  if (!options.includeRemoved) conditions.push(isNull(socialDestinations.removedAt));

  return db
    .select()
    .from(socialDestinations)
    .where(and(...conditions))
    .orderBy(asc(socialDestinations.name));
}

export async function findDestinationById(
  db: Database,
  projectEnvironmentId: string,
  destinationId: string,
): Promise<SocialDestination | null> {
  const rows = await db
    .select()
    .from(socialDestinations)
    .where(
      and(
        eq(socialDestinations.id, destinationId),
        eq(socialDestinations.projectEnvironmentId, projectEnvironmentId),
        isNull(socialDestinations.removedAt),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The full ownership chain for a destination (plan P5, §10.3).
 *
 * `destination → connection → profile → environment → project`, resolved in one query.
 * Deliberately not environment-filtered: the caller compares the result against the
 * principal, and filtering here would turn a cross-tenant attempt into a 404 and hide it
 * from the check meant to catch it.
 *
 * Also returns connection health and setup state, because every caller that needs
 * ownership also needs to know whether the destination can actually publish — and making
 * that a second query is how a stale health check slips into a publish decision.
 */
export interface DestinationOwnership {
  destinationId: string;
  connectionId: string;
  profileId: string;
  projectEnvironmentId: string;
  projectId: string;
  organizationId: string;
  provider: string;
  providerDestinationId: string;
  destinationName: string;
  selected: boolean;
  connectionHealth: SocialConnection['health'];
  setupCompletedAt: Date | null;
  disconnectedAt: Date | null;
  profileDisabledAt: Date | null;
  profileDeletedAt: Date | null;
}

export async function findDestinationOwnership(
  db: Database,
  destinationId: string,
): Promise<DestinationOwnership | null> {
  const rows = await db
    .select({
      destinationId: socialDestinations.id,
      connectionId: socialConnections.id,
      profileId: profiles.id,
      projectEnvironmentId: profiles.projectEnvironmentId,
      projectId: profiles.projectId,
      organizationId: profiles.organizationId,
      provider: socialDestinations.provider,
      providerDestinationId: socialDestinations.providerDestinationId,
      destinationName: socialDestinations.name,
      selected: socialDestinations.selected,
      connectionHealth: socialConnections.health,
      setupCompletedAt: socialConnections.setupCompletedAt,
      disconnectedAt: socialConnections.disconnectedAt,
      profileDisabledAt: profiles.disabledAt,
      profileDeletedAt: profiles.deletedAt,
    })
    .from(socialDestinations)
    .innerJoin(socialConnections, eq(socialConnections.id, socialDestinations.connectionId))
    .innerJoin(profiles, eq(profiles.id, socialConnections.profileId))
    .where(and(eq(socialDestinations.id, destinationId), isNull(socialDestinations.removedAt)))
    .limit(1);

  return rows[0] ?? null;
}

/** Batch form, so validating a multi-target post is one query rather than one per target. */
export async function findDestinationOwnerships(
  db: Database,
  destinationIds: readonly string[],
): Promise<Map<string, DestinationOwnership>> {
  const result = new Map<string, DestinationOwnership>();
  if (destinationIds.length === 0) return result;

  const rows = await db
    .select({
      destinationId: socialDestinations.id,
      connectionId: socialConnections.id,
      profileId: profiles.id,
      projectEnvironmentId: profiles.projectEnvironmentId,
      projectId: profiles.projectId,
      organizationId: profiles.organizationId,
      provider: socialDestinations.provider,
      providerDestinationId: socialDestinations.providerDestinationId,
      destinationName: socialDestinations.name,
      selected: socialDestinations.selected,
      connectionHealth: socialConnections.health,
      setupCompletedAt: socialConnections.setupCompletedAt,
      disconnectedAt: socialConnections.disconnectedAt,
      profileDisabledAt: profiles.disabledAt,
      profileDeletedAt: profiles.deletedAt,
    })
    .from(socialDestinations)
    .innerJoin(socialConnections, eq(socialConnections.id, socialDestinations.connectionId))
    .innerJoin(profiles, eq(profiles.id, socialConnections.profileId))
    .where(
      and(inArray(socialDestinations.id, [...destinationIds]), isNull(socialDestinations.removedAt)),
    );

  for (const row of rows) result.set(row.destinationId, row);
  return result;
}

/** Cache an effective-capability document on a destination (plan §17). */
export async function storeDestinationCapabilities(
  db: Database,
  destinationId: string,
  capabilities: Record<string, unknown>,
): Promise<void> {
  await db
    .update(socialDestinations)
    .set({ capabilities, capabilitiesRefreshedAt: new Date(), updatedAt: new Date() })
    .where(eq(socialDestinations.id, destinationId));
}

/** Health transition, recorded on the connection (the audit trail lives in §42's table). */
export async function setConnectionHealth(
  db: Database,
  connectionId: string,
  health: SocialConnection['health'],
  detail: string | null,
): Promise<void> {
  await db
    .update(socialConnections)
    .set({ health, healthDetail: detail, healthCheckedAt: new Date(), updatedAt: new Date() })
    .where(eq(socialConnections.id, connectionId));
}

// ---------------------------------------------------------------------------
// Writes — completing an authorization (plan §21.2)
// ---------------------------------------------------------------------------

/**
 * A credential as the engine hands it over: already encrypted, always.
 *
 * The repository moves ciphertext and never plaintext (P9, ADR-007). Accepting a token
 * here and encrypting inside would put a key in the data layer, which is the one place
 * every query path already reaches.
 */
export interface EncryptedCredentialInput {
  credentialType: SocialCredential['credentialType'];
  ciphertext: string;
  nonce: string;
  algorithm: string;
  keyVersion: number;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
}

export interface SaveDestinationInput {
  /** Allocated by `planConnectionIds`, because the credential AAD binds it. */
  destinationId: string;
  externalId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  url: string | null;
  destinationType: string;
  metadata: Record<string, unknown>;
  /** Present when the provider issues a token per surface — a Meta Page being the case. */
  credentials: EncryptedCredentialInput[];
}

export interface SaveConnectionInput {
  /** Allocated by `planConnectionIds`. */
  connectionId: string;
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  profileId: string;
  provider: string;
  authStrategy: SocialConnection['authStrategy'];
  providerAppId: string | null;
  providerAccountId: string;
  providerAccountName: string | null;
  providerAccountHandle: string | null;
  providerAccountAvatarUrl: string | null;
  grantedScopes: readonly string[];
  metadata: Record<string, unknown>;
  credentials: EncryptedCredentialInput[];
  destinations: readonly SaveDestinationInput[];
}

/**
 * Allocate the ids a completed authorization will be written under, before anything is
 * encrypted.
 *
 * This exists because of the credential AAD (ADR-007): a ciphertext is bound to its
 * organization, project, connection and — for a per-surface token — its destination. The
 * ids therefore have to be known at encryption time, which is *before* the write. The
 * alternative would be handing plaintext tokens to the repository so it could encrypt
 * after assigning ids, and a repository that can encrypt is a repository holding a key.
 *
 * Reusing the existing ids on a reconnect is what makes re-authorization non-destructive:
 * posts, targets and attempts already reference this connection and these destinations,
 * and minting new ids would orphan all of it.
 */
export interface ConnectionIdPlan {
  connectionId: string;
  /** False when this reconnects an account that already has a live connection. */
  isNew: boolean;
  /** Existing destination id per provider-side external id. */
  destinationIdByExternalId: Map<string, string>;
  setupCompletedAt: Date | null;
}

export async function planConnectionIds(
  db: Database,
  input: { profileId: string; provider: string; providerAccountId: string },
): Promise<ConnectionIdPlan> {
  const existing = await db
    .select({ id: socialConnections.id, setupCompletedAt: socialConnections.setupCompletedAt })
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.profileId, input.profileId),
        eq(socialConnections.provider, input.provider),
        eq(socialConnections.providerAccountId, input.providerAccountId),
        isNull(socialConnections.disconnectedAt),
      ),
    )
    .limit(1);

  const previous = existing[0];
  if (!previous) {
    return {
      connectionId: newUuidV7(),
      isNew: true,
      destinationIdByExternalId: new Map(),
      setupCompletedAt: null,
    };
  }

  // Removed destinations are included: a Page the user removed and re-added should
  // resurrect its original row rather than become a second one pointing at the same Page.
  const destinations = await db
    .select({ id: socialDestinations.id, externalId: socialDestinations.providerDestinationId })
    .from(socialDestinations)
    .where(eq(socialDestinations.connectionId, previous.id));

  return {
    connectionId: previous.id,
    isNew: false,
    destinationIdByExternalId: new Map(destinations.map((row) => [row.externalId, row.id])),
    setupCompletedAt: previous.setupCompletedAt,
  };
}

export interface SaveConnectionResult {
  connectionId: string;
  /** False when this re-authorized an existing connection rather than creating one. */
  created: boolean;
  destinationCount: number;
  /** Null while a secondary selection is still outstanding (plan §21.3). */
  setupCompletedAt: Date | null;
}

/**
 * Persist a completed authorization: connection, scopes, credentials and destinations.
 *
 * One transaction, because a connection without its credentials is worse than no
 * connection at all — it appears in the dashboard as something that should work, and
 * fails at publish time with an error about a missing token that names no cause.
 *
 * Upsert rather than insert on `(profile, provider, provider_account)`. Re-authorizing an
 * account the customer already connected is the common path, not the exception: tokens
 * expire, scopes get added, users re-run the connect flow because they are unsure. Insert
 * would either collide with the partial unique index or, without one, quietly produce two
 * live connections to the same account — and a post targeting "the Instagram connection"
 * would then publish twice.
 *
 * Destination selection follows plan §21.3. A single returned destination is selected
 * automatically and completes setup: making a Bluesky user choose from a list of one is
 * friction with no decision in it. Several destinations leave the connection deliberately
 * incomplete, because publishing to every Page a user happens to administer is a mistake
 * that cannot be taken back.
 */
export async function saveConnection(
  db: Database,
  input: SaveConnectionInput,
): Promise<SaveConnectionResult> {
  const now = new Date();
  const autoSelect = input.destinations.length === 1;
  const connectionId = input.connectionId;

  return db.transaction(async (tx: Transaction) => {
    const existing = await tx
      .select({ id: socialConnections.id, setupCompletedAt: socialConnections.setupCompletedAt })
      .from(socialConnections)
      .where(
        and(
          eq(socialConnections.profileId, input.profileId),
          eq(socialConnections.provider, input.provider),
          eq(socialConnections.providerAccountId, input.providerAccountId),
          isNull(socialConnections.disconnectedAt),
        ),
      )
      .limit(1);

    const previous = existing[0];

    /**
     * Re-read inside the transaction rather than trusting the plan, because a concurrent
     * connect for the same account could have created the row in between. Writing anyway
     * would either violate the partial unique index or attach credentials whose AAD names
     * a connection id that is not the live one — a decryption failure discovered at
     * publish time, which is the worst possible moment. Failing here is loud and the
     * caller's retry succeeds against the now-existing connection (Rule 14).
     */
    if (previous && previous.id !== connectionId) {
      throw new Error(
        'This social account was connected concurrently by another request. Retry the authorization.',
      );
    }

    // Setup stays complete once it is complete: a re-authorization of a connection whose
    // destination was already chosen must not silently un-choose it and stop publishing.
    const setupCompletedAt = previous?.setupCompletedAt ?? (autoSelect ? now : null);

    if (previous) {
      await tx
        .update(socialConnections)
        .set({
          providerAppId: input.providerAppId,
          authStrategy: input.authStrategy,
          providerAccountName: input.providerAccountName,
          providerAccountHandle: input.providerAccountHandle,
          providerAccountAvatarUrl: input.providerAccountAvatarUrl,
          health: 'healthy',
          healthDetail: null,
          healthCheckedAt: now,
          setupCompletedAt,
          metadata: input.metadata,
          // A reconnect clears any stale refresh lock; the credential it guarded is gone.
          refreshLockedUntil: null,
          updatedAt: now,
        })
        .where(eq(socialConnections.id, connectionId));
    } else {
      await tx.insert(socialConnections).values({
        id: connectionId,
        profileId: input.profileId,
        projectEnvironmentId: input.projectEnvironmentId,
        projectId: input.projectId,
        organizationId: input.organizationId,
        providerAppId: input.providerAppId,
        provider: input.provider,
        authStrategy: input.authStrategy,
        providerAccountId: input.providerAccountId,
        providerAccountName: input.providerAccountName,
        providerAccountHandle: input.providerAccountHandle,
        providerAccountAvatarUrl: input.providerAccountAvatarUrl,
        health: 'healthy',
        healthCheckedAt: now,
        setupCompletedAt,
        connectedAt: now,
        metadata: input.metadata,
      });
    }

    // Scopes are replaced wholesale rather than merged. They describe what the provider
    // granted *this* time, and a scope the user declined on re-consent must disappear —
    // merging would leave the connection claiming a permission it no longer has, which
    // preflight would then use to promise a capability that fails.
    await tx.delete(connectionScopes).where(eq(connectionScopes.connectionId, connectionId));
    if (input.grantedScopes.length > 0) {
      await tx.insert(connectionScopes).values(
        [...new Set(input.grantedScopes)].map((scope) => ({
          id: newUuidV7(),
          connectionId,
          scope,
          granted: true,
          observedAt: now,
        })),
      );
    }

    for (const credential of input.credentials) {
      await upsertCredential(tx, {
        connectionId,
        destinationId: null,
        organizationId: input.organizationId,
        projectId: input.projectId,
        credential,
      });
    }

    const destinationIds: string[] = [];

    for (const destination of input.destinations) {
      const destinationId = destination.destinationId;
      destinationIds.push(destinationId);

      const existingDestination = await tx
        .select({ id: socialDestinations.id })
        .from(socialDestinations)
        .where(eq(socialDestinations.id, destinationId))
        .limit(1);

      const found = existingDestination[0];

      if (found) {
        await tx
          .update(socialDestinations)
          .set({
            name: destination.name,
            handle: destination.handle,
            avatarUrl: destination.avatarUrl,
            url: destination.url,
            destinationType: destination.destinationType,
            metadata: destination.metadata,
            // A destination that reappears was not removed after all.
            removedAt: null,
            updatedAt: now,
          })
          .where(eq(socialDestinations.id, destinationId));
      } else {
        await tx.insert(socialDestinations).values({
          id: destinationId,
          connectionId,
          profileId: input.profileId,
          projectEnvironmentId: input.projectEnvironmentId,
          organizationId: input.organizationId,
          provider: input.provider,
          providerDestinationId: destination.externalId,
          destinationType: destination.destinationType,
          name: destination.name,
          handle: destination.handle,
          avatarUrl: destination.avatarUrl,
          url: destination.url,
          selected: autoSelect,
          metadata: destination.metadata,
        });
      }

      for (const credential of destination.credentials) {
        await upsertCredential(tx, {
          connectionId,
          destinationId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          credential,
        });
      }
    }

    // Destinations the provider no longer returns are marked removed, not deleted. A post
    // that published to a Page the user has since left still points at this row, and
    // deleting it would break the historical record the timeline is built from.
    const removalConditions = [
      eq(socialDestinations.connectionId, connectionId),
      isNull(socialDestinations.removedAt),
    ];
    if (destinationIds.length > 0) {
      removalConditions.push(notInArray(socialDestinations.id, destinationIds));
    }
    await tx
      .update(socialDestinations)
      .set({ removedAt: now, selected: false, updatedAt: now })
      .where(and(...removalConditions));

    return {
      connectionId,
      created: !previous,
      destinationCount: input.destinations.length,
      setupCompletedAt,
    };
  });
}

/**
 * Insert or replace one credential.
 *
 * Split out because the connection-level and destination-level cases differ only in which
 * partial unique index they collide against, and Drizzle needs the matching `targetWhere`
 * for `ON CONFLICT` to find it at all.
 */
async function upsertCredential(
  tx: Transaction,
  input: {
    connectionId: string;
    destinationId: string | null;
    organizationId: string;
    projectId: string;
    credential: EncryptedCredentialInput;
  },
): Promise<void> {
  const { credential } = input;

  const values = {
    id: newUuidV7(),
    connectionId: input.connectionId,
    destinationId: input.destinationId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    credentialType: credential.credentialType,
    ciphertext: credential.ciphertext,
    nonce: credential.nonce,
    algorithm: credential.algorithm,
    keyVersion: credential.keyVersion,
    expiresAt: credential.expiresAt,
    refreshExpiresAt: credential.refreshExpiresAt,
  };

  const set = {
    ciphertext: credential.ciphertext,
    nonce: credential.nonce,
    algorithm: credential.algorithm,
    keyVersion: credential.keyVersion,
    expiresAt: credential.expiresAt,
    refreshExpiresAt: credential.refreshExpiresAt,
    updatedAt: new Date(),
  };

  if (input.destinationId === null) {
    await tx
      .insert(socialCredentials)
      .values(values)
      .onConflictDoUpdate({
        target: [socialCredentials.connectionId, socialCredentials.credentialType],
        targetWhere: isNull(socialCredentials.destinationId),
        set,
      });
    return;
  }

  await tx
    .insert(socialCredentials)
    .values(values)
    .onConflictDoUpdate({
      target: [socialCredentials.destinationId, socialCredentials.credentialType],
      targetWhere: sql`${socialCredentials.destinationId} IS NOT NULL`,
      set,
    });
}

/**
 * Choose which destinations a connection publishes to (plan §21.3).
 *
 * Selecting at least one completes setup. Selecting none is allowed and reverses it — a
 * customer who deselects every Page has said "do not publish anywhere", and honouring
 * that as an incomplete connection is better than silently keeping the last selection.
 */
export async function selectConnectionDestinations(
  db: Database,
  input: {
    projectEnvironmentId: string;
    connectionId: string;
    destinationIds: readonly string[];
  },
): Promise<SocialDestination[]> {
  const now = new Date();

  return db.transaction(async (tx: Transaction) => {
    await tx
      .update(socialDestinations)
      .set({ selected: false, updatedAt: now })
      .where(
        and(
          eq(socialDestinations.connectionId, input.connectionId),
          eq(socialDestinations.projectEnvironmentId, input.projectEnvironmentId),
        ),
      );

    if (input.destinationIds.length > 0) {
      await tx
        .update(socialDestinations)
        .set({ selected: true, updatedAt: now })
        .where(
          and(
            eq(socialDestinations.connectionId, input.connectionId),
            eq(socialDestinations.projectEnvironmentId, input.projectEnvironmentId),
            inArray(socialDestinations.id, [...input.destinationIds]),
            isNull(socialDestinations.removedAt),
          ),
        );
    }

    await tx
      .update(socialConnections)
      .set({
        setupCompletedAt: input.destinationIds.length > 0 ? now : null,
        updatedAt: now,
      })
      .where(eq(socialConnections.id, input.connectionId));

    return tx
      .select()
      .from(socialDestinations)
      .where(
        and(
          eq(socialDestinations.connectionId, input.connectionId),
          isNull(socialDestinations.removedAt),
        ),
      )
      .orderBy(asc(socialDestinations.name));
  });
}

export async function countConnections(
  db: Database,
  projectEnvironmentId: string,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(socialConnections)
    .where(
      and(
        eq(socialConnections.projectEnvironmentId, projectEnvironmentId),
        isNull(socialConnections.disconnectedAt),
      ),
    );

  return rows[0]?.count ?? 0;
}
