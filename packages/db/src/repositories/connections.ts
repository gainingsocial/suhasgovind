import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import {
  connectionScopes,
  socialConnections,
  socialDestinations,
  type SocialConnection,
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
