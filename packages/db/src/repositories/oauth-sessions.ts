import { newUuidV7 } from '@gs/contracts/ids';
import { and, eq, gt, lt, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { oauthSessions, type OAuthSession } from '../schema/connections.js';

/**
 * Short-lived OAuth handshake state (plan §21.1, §21.2).
 *
 * The load-bearing operation here is `consumeOAuthSession`. A provider callback is an
 * unauthenticated request carrying an attacker-influenceable query string, and the state
 * parameter is the only thing tying it back to a tenant. Two properties follow:
 *
 *   1. The lookup must be by `state` alone — there is no principal to scope it by. Every
 *      other field (profile, environment, provider app) is read *from the row*, never
 *      from the callback, so a forged callback cannot redirect a connection into someone
 *      else's tenant.
 *   2. Consumption must be atomic. A callback can arrive twice — providers retry, users
 *      refresh, and an attacker replays deliberately — and exchanging the same
 *      authorization code twice either fails confusingly or, worse, succeeds and creates
 *      a second connection. The conditional UPDATE below is the same shape as the target
 *      lease in `posts.ts` and for the same reason: the check and the claim have to be
 *      one statement.
 */

export interface CreateOAuthSessionInput {
  projectEnvironmentId: string;
  profileId: string;
  providerAppId: string;
  provider: string;
  state: string;
  encryptedCodeVerifier: OAuthSession['encryptedCodeVerifier'];
  redirectUri: string;
  returnUrl: string | null;
  requestedScopes: readonly string[];
  connectSessionId?: string | null;
  reconnectConnectionId?: string | null;
  expiresAt: Date;
  traceId?: string | null;
}

export async function createOAuthSession(
  db: Database,
  input: CreateOAuthSessionInput,
): Promise<OAuthSession> {
  const rows = await db
    .insert(oauthSessions)
    .values({
      id: newUuidV7(),
      projectEnvironmentId: input.projectEnvironmentId,
      profileId: input.profileId,
      providerAppId: input.providerAppId,
      provider: input.provider,
      state: input.state,
      encryptedCodeVerifier: input.encryptedCodeVerifier,
      redirectUri: input.redirectUri,
      returnUrl: input.returnUrl,
      requestedScopes: [...input.requestedScopes],
      connectSessionId: input.connectSessionId ?? null,
      reconnectConnectionId: input.reconnectConnectionId ?? null,
      expiresAt: input.expiresAt,
      traceId: input.traceId ?? null,
    })
    .returning();

  // The insert either produced a row or threw; a missing row here means the driver
  // returned something impossible, and continuing would mean dereferencing undefined.
  const row = rows[0];
  if (!row) throw new Error('Failed to create the OAuth session.');
  return row;
}

/**
 * Claim a pending session by its state, exactly once.
 *
 * Returns null when the state is unknown, already consumed, or expired — three cases the
 * caller deliberately cannot distinguish. Telling an unauthenticated caller that a state
 * *existed* but had already been used confirms a valid handshake to whoever replayed it.
 */
export async function consumeOAuthSession(
  db: Database,
  state: string,
): Promise<OAuthSession | null> {
  const now = new Date();

  const rows = await db
    .update(oauthSessions)
    .set({ status: 'consumed', consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(oauthSessions.state, state),
        eq(oauthSessions.status, 'pending'),
        // `gt` rather than a raw `sql` template: the typed helper applies the column's
        // driver mapper, and a raw template binds the JS Date as its `toString()` — a
        // value Postgres cannot parse as a timestamptz at all.
        gt(oauthSessions.expiresAt, now),
      ),
    )
    .returning();

  return rows[0] ?? null;
}

/** Read a pending session without claiming it — used to render the hosted connect page. */
export async function findPendingOAuthSession(
  db: Database,
  state: string,
): Promise<OAuthSession | null> {
  const rows = await db
    .select()
    .from(oauthSessions)
    .where(and(eq(oauthSessions.state, state), eq(oauthSessions.status, 'pending')))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return row.expiresAt > new Date() ? row : null;
}

/**
 * Mark a consumed session as failed.
 *
 * Recorded rather than deleted: "the user started a LinkedIn connect and the exchange
 * failed" is the single most common support question about connecting, and a row that
 * says so beats an absence that says nothing.
 */
export async function failOAuthSession(db: Database, sessionId: string): Promise<void> {
  await db
    .update(oauthSessions)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(eq(oauthSessions.id, sessionId));
}

/**
 * Retire pending sessions past their expiry.
 *
 * Housekeeping, not security — `consumeOAuthSession` already refuses an expired row, so
 * this only keeps the table honest for anyone reading it.
 */
export async function expireStaleOAuthSessions(db: Database, limit = 500): Promise<number> {
  const rows = await db
    .update(oauthSessions)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(oauthSessions.status, 'pending'),
        lt(oauthSessions.expiresAt, new Date()),
        sql`${oauthSessions.id} IN (
          SELECT id FROM ${oauthSessions}
          WHERE status = 'pending' AND expires_at < now()
          LIMIT ${limit}
        )`,
      ),
    )
    .returning({ id: oauthSessions.id });

  return rows.length;
}
