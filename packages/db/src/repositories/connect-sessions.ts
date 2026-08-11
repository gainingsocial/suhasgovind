import { newUuidV7 } from '@gs/contracts/ids';
import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '../client.js';
import { connectSessions, type ConnectSession } from '../schema/connections.js';
import { profiles } from '../schema/tenancy.js';

/**
 * Hosted white-label connect sessions (plan §22).
 *
 * A connect session is a capability handed to somebody who has no account with us: the
 * customer's end user, arriving from the customer's own app. It carries its own tenancy,
 * which is exactly why the row stores `project_environment_id` and `profile_id` at
 * creation time and the hosted page reads them from here rather than from anything in the
 * request. The token in the URL proves possession; the row decides what that possession
 * grants.
 */

export interface CreateConnectSessionInput {
  projectEnvironmentId: string;
  profileId: string;
  providers: readonly string[];
  branding: Record<string, unknown>;
  returnUrl: string | null;
  expiresAt: Date;
  createdByApiKeyId: string | null;
}

export async function createConnectSession(
  db: Database,
  input: CreateConnectSessionInput,
): Promise<ConnectSession> {
  const rows = await db
    .insert(connectSessions)
    .values({
      id: newUuidV7(),
      projectEnvironmentId: input.projectEnvironmentId,
      profileId: input.profileId,
      providers: [...input.providers],
      branding: input.branding,
      returnUrl: input.returnUrl,
      expiresAt: input.expiresAt,
      createdByApiKeyId: input.createdByApiKeyId,
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('Failed to create the connect session.');
  return row;
}

export interface ConnectSessionWithProfile extends ConnectSession {
  profileName: string;
  organizationId: string;
  projectId: string;
  /** True once past `expires_at`. The caller decides what to render; this states the fact. */
  expired: boolean;
}

/**
 * Load a session for the hosted page.
 *
 * Deliberately not environment-filtered: the hosted page has no principal to filter by.
 * The session id arrives inside a signed token, and the signature is what authorizes the
 * read — see `packages/auth` for the verification. Returning the tenancy from the row is
 * what keeps every subsequent write scoped correctly.
 */
export async function findConnectSessionById(
  db: Database,
  connectSessionId: string,
): Promise<ConnectSessionWithProfile | null> {
  const rows = await db
    .select({
      session: connectSessions,
      profileName: profiles.name,
      organizationId: profiles.organizationId,
      projectId: profiles.projectId,
    })
    .from(connectSessions)
    .innerJoin(profiles, eq(profiles.id, connectSessions.profileId))
    .where(eq(connectSessions.id, connectSessionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    ...row.session,
    profileName: row.profileName,
    organizationId: row.organizationId,
    projectId: row.projectId,
    expired: row.session.expiresAt <= new Date(),
  };
}

/**
 * Mark a session finished.
 *
 * Not idempotency-critical — a session that completes twice is harmless — so this stamps
 * the first completion and leaves it alone afterwards, which keeps the timestamp
 * meaningful as "when the user finished".
 */
export async function completeConnectSession(
  db: Database,
  connectSessionId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(connectSessions)
    .set({ completedAt: now, updatedAt: now })
    .where(and(eq(connectSessions.id, connectSessionId), isNull(connectSessions.completedAt)));
}
