import { newUuidV7 } from '@gs/contracts/ids';
import { ApiError } from '@gs/errors';
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { socialConnections } from '../schema/connections.js';
import { profiles, type Profile } from '../schema/tenancy.js';
import { deleteConnectionCredentials } from './credentials.js';

/**
 * Profile repository (plan §76 — domain operations, not CRUD).
 *
 * Every query here is scoped by `projectEnvironmentId`, taken from the authenticated
 * principal and never from the request. That is the mechanical half of tenant isolation
 * (P5): a caller cannot widen the scope of a query it does not control the parameters of.
 *
 * Soft deletion throughout. A hard delete would strand queued publish targets with an
 * unresolvable tenancy chain, and the ownership check on the way to publishing them
 * would then fail in a way indistinguishable from an attack.
 */

export interface ProfileScope {
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
}

export interface CreateProfileInput extends ProfileScope {
  name: string;
  externalId: string | null;
  timezone: string;
  metadata: Record<string, unknown>;
}

export interface ListProfilesInput extends Pick<ProfileScope, 'projectEnvironmentId'> {
  limit: number;
  order: 'asc' | 'desc';
  /** Exclusive: rows strictly after (or before, when descending) this id. */
  cursor?: string;
  externalId?: string;
  /** Set when the key may only see one profile (plan §38). */
  restrictedToProfileId?: string | null;
}

export interface UpdateProfileInput {
  name?: string;
  externalId?: string | null;
  timezone?: string;
  metadata?: Record<string, unknown>;
  disabled?: boolean;
}

/**
 * Postgres unique-violation (SQLSTATE 23505). Distinguishing it from a generic failure is
 * the difference between a 409 the caller can act on and a 500 that looks like our fault.
 *
 * Walks the `cause` chain: Drizzle wraps driver errors in its own `DrizzleQueryError`, so
 * the SQLSTATE is not on the object that gets thrown. Checking only the top level silently
 * turns every conflict into a 500 — which is exactly what it did before this walked.
 */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current != null && depth < 5; depth += 1) {
    if (typeof current === 'object' && 'code' in current && current.code === '23505') return true;
    current = typeof current === 'object' && 'cause' in current ? current.cause : null;
  }
  return false;
}

export async function createProfile(db: Database, input: CreateProfileInput): Promise<Profile> {
  try {
    const rows = await db
      .insert(profiles)
      .values({
        // UUIDv7 rather than a database default: the id is needed before the insert
        // resolves in some call paths, and time-ordered ids keep b-tree inserts sequential.
        id: newUuidV7(),
        organizationId: input.organizationId,
        projectId: input.projectId,
        projectEnvironmentId: input.projectEnvironmentId,
        name: input.name,
        externalId: input.externalId,
        timezone: input.timezone,
        metadata: input.metadata,
      })
      .returning();

    const created = rows[0];
    if (!created) throw new ApiError('INTERNAL_ERROR', { message: 'Profile insert returned no row.' });
    return created;
  } catch (error) {
    if (isUniqueViolation(error)) {
      // The partial unique index only covers live rows, so this genuinely means "an
      // active profile already claims that external_id in this environment".
      throw new ApiError('RESOURCE_ALREADY_EXISTS', {
        message: `A profile with external_id "${input.externalId}" already exists in this environment.`,
      });
    }
    throw error;
  }
}

/**
 * Fetch one profile within an environment.
 *
 * Environment-scoped in the WHERE clause rather than fetched-then-checked. Both are
 * correct, but filtering means a cross-tenant id simply does not match, so there is no
 * window in which another tenant's row exists in memory.
 */
export async function findProfileById(
  db: Database,
  projectEnvironmentId: string,
  profileId: string,
): Promise<Profile | null> {
  const rows = await db
    .select()
    .from(profiles)
    .where(
      and(
        eq(profiles.id, profileId),
        eq(profiles.projectEnvironmentId, projectEnvironmentId),
        isNull(profiles.deletedAt),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function listProfiles(
  db: Database,
  input: ListProfilesInput,
): Promise<{ rows: Profile[]; hasMore: boolean }> {
  const conditions = [
    eq(profiles.projectEnvironmentId, input.projectEnvironmentId),
    isNull(profiles.deletedAt),
  ];

  if (input.externalId !== undefined) {
    conditions.push(eq(profiles.externalId, input.externalId));
  }

  // A profile-restricted key sees exactly one profile, enforced in SQL so the route
  // cannot forget to filter (plan §38).
  if (input.restrictedToProfileId != null) {
    conditions.push(eq(profiles.id, input.restrictedToProfileId));
  }

  if (input.cursor) {
    // UUIDv7 sorts by creation time, so the id is a valid cursor with no extra column.
    conditions.push(
      input.order === 'desc' ? lt(profiles.id, input.cursor) : gt(profiles.id, input.cursor),
    );
  }

  // Over-fetch by one to answer `has_more` without a COUNT over the whole tenant.
  const rows = await db
    .select()
    .from(profiles)
    .where(and(...conditions))
    .orderBy(input.order === 'desc' ? desc(profiles.id) : asc(profiles.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  return { rows: hasMore ? rows.slice(0, input.limit) : rows, hasMore };
}

export async function updateProfile(
  db: Database,
  projectEnvironmentId: string,
  profileId: string,
  input: UpdateProfileInput,
): Promise<Profile | null> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  // Only keys actually present are written. Spreading the whole input would turn an
  // absent field into an explicit null and silently clear it.
  if (input.name !== undefined) patch.name = input.name;
  if (input.externalId !== undefined) patch.externalId = input.externalId;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  if (input.disabled !== undefined) patch.disabledAt = input.disabled ? new Date() : null;

  try {
    const rows = await db
      .update(profiles)
      .set(patch)
      .where(
        and(
          eq(profiles.id, profileId),
          eq(profiles.projectEnvironmentId, projectEnvironmentId),
          isNull(profiles.deletedAt),
        ),
      )
      .returning();

    return rows[0] ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError('RESOURCE_ALREADY_EXISTS', {
        message: `A profile with external_id "${input.externalId}" already exists in this environment.`,
      });
    }
    throw error;
  }
}

/**
 * Soft-delete a profile, disconnecting its accounts and destroying their credentials.
 *
 * Returns false when nothing matched, which the route turns into a 404. Deleting an
 * already-deleted profile is therefore not an error the second time in the sense that
 * matters — the caller's intent is satisfied either way — but it does report `false` so
 * the route can distinguish "gone" from "never existed within your tenant".
 *
 * The cascade to credentials is the part that matters for a deletion request. A profile
 * is the identity somebody publishes on behalf of, so deleting one is a customer saying
 * they are finished with that brand or client — and leaving live provider access tokens
 * behind for accounts nobody can reach any more is precisely what a platform's data
 * deletion review exists to catch (P9). The connection rows survive as history; the
 * secrets do not.
 */
export async function softDeleteProfile(
  db: Database,
  projectEnvironmentId: string,
  profileId: string,
): Promise<boolean> {
  const now = new Date();

  return db.transaction(async (tx) => {
    const rows = await tx
      .update(profiles)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(profiles.id, profileId),
          eq(profiles.projectEnvironmentId, projectEnvironmentId),
          isNull(profiles.deletedAt),
        ),
      )
      .returning({ id: profiles.id });

    if (rows.length === 0) return false;

    const connections = await tx
      .update(socialConnections)
      .set({ disconnectedAt: now, health: 'disconnected', updatedAt: now })
      .where(
        and(
          eq(socialConnections.profileId, profileId),
          eq(socialConnections.projectEnvironmentId, projectEnvironmentId),
          isNull(socialConnections.disconnectedAt),
        ),
      )
      .returning({ id: socialConnections.id });

    for (const connection of connections) {
      await deleteConnectionCredentials(tx, connection.id);
    }

    return true;
  });
}

/**
 * Resolve a profile's tenancy chain for an ownership check (plan P5, §10.3).
 *
 * Deliberately NOT environment-filtered: the caller needs to know who actually owns the
 * row so `assertOwnership` can compare it against the principal. Filtering here would
 * turn a cross-tenant access attempt into a 404 and hide it from the check that is
 * supposed to catch it.
 */
export async function findProfileOwnership(
  db: Database,
  profileId: string,
): Promise<{
  organizationId: string;
  projectId: string;
  projectEnvironmentId: string;
  profileId: string;
} | null> {
  const rows = await db
    .select({
      organizationId: profiles.organizationId,
      projectId: profiles.projectId,
      projectEnvironmentId: profiles.projectEnvironmentId,
      profileId: profiles.id,
    })
    .from(profiles)
    .where(and(eq(profiles.id, profileId), isNull(profiles.deletedAt)))
    .limit(1);

  return rows[0] ?? null;
}

/** Count active profiles in an environment. Used for plan-limit enforcement (plan §70). */
export async function countProfiles(db: Database, projectEnvironmentId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(profiles)
    .where(
      and(eq(profiles.projectEnvironmentId, projectEnvironmentId), isNull(profiles.deletedAt)),
    );

  return rows[0]?.count ?? 0;
}
