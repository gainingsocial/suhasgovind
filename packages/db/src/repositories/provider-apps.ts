import { newUuidV7 } from '@gs/contracts/ids';
import { ApiError } from '@gs/errors';
import { and, desc, eq, isNull } from 'drizzle-orm';

import type { Database, Transaction } from '../client.js';
import { providerApps, type ProviderApp } from '../schema/connections.js';

/**
 * Platform application credentials (plan §23).
 *
 * This is the mechanism that lets a platform go live without a code change. Every adapter
 * reads its client id and secret from here at call time, so the day LinkedIn or Meta
 * grants approval, the credentials are pasted into one row and that provider starts
 * working — no deploy, no edit, no restart.
 *
 * The alternative — credentials in environment variables — would mean a deploy per
 * approval, and would make customer-managed apps impossible, since an environment
 * variable cannot vary per project.
 *
 * Two ownership models, both supported from day one so adding the second later is not a
 * schema rewrite (plan §23):
 *
 *   platform_managed  our application, shared by every customer. The default.
 *   customer_managed  an enterprise brings their own Meta or LinkedIn app, scoped to
 *                     their project.
 *
 * The client secret is stored encrypted, exactly like a user token. A platform client
 * secret is arguably more valuable than any single user's token, because it is the key to
 * every connection made through that application.
 */

export interface ProviderAppCredentialFields {
  clientId: string;
  /**
   * The encrypted secret exactly as `@gs/crypto` produced it. Encryption happens there and
   * never here (P9) — a repository that could encrypt would be a repository holding a key.
   */
  encryptedClientSecret: {
    ciphertext: string;
    nonce: string;
    algorithm: string;
    keyVersion: number;
  };
}

export interface UpsertProviderAppInput extends ProviderAppCredentialFields {
  provider: string;
  /** Null for a platform-managed app shared across every project. */
  projectId: string | null;
  ownership: 'platform_managed' | 'customer_managed';
  redirectUri: string;
  scopes: readonly string[];
  approvalStatus: string;
  metadata?: Record<string, unknown>;
}

/**
 * Resolve the application an adapter should use for a given provider and project.
 *
 * A customer-managed app wins over the platform default when one exists for that project.
 * That precedence is what lets an enterprise bring their own Meta app without affecting
 * anybody else, and it is checked in one query rather than two so a publish does not pay
 * for the flexibility.
 */
export async function findProviderApp(
  db: Database,
  provider: string,
  projectId: string | null,
): Promise<ProviderApp | null> {
  if (projectId) {
    const own = await db
      .select()
      .from(providerApps)
      .where(
        and(
          eq(providerApps.provider, provider),
          eq(providerApps.projectId, projectId),
          eq(providerApps.ownership, 'customer_managed'),
        ),
      )
      .limit(1);

    if (own[0]) return own[0];
  }

  const shared = await db
    .select()
    .from(providerApps)
    .where(
      and(
        eq(providerApps.provider, provider),
        isNull(providerApps.projectId),
        eq(providerApps.ownership, 'platform_managed'),
      ),
    )
    .limit(1);

  return shared[0] ?? null;
}

/**
 * Create or replace an application's credentials.
 *
 * Upsert rather than insert, because the common case is re-pasting a rotated secret. An
 * insert-only API would accumulate rows and leave "which one is current" undefined —
 * exactly the ambiguity that produces a publish signed with a revoked secret.
 */
export async function upsertProviderApp(
  db: Database,
  input: UpsertProviderAppInput,
): Promise<ProviderApp> {
  const existing = await db
    .select({ id: providerApps.id })
    .from(providerApps)
    .where(
      and(
        eq(providerApps.provider, input.provider),
        input.projectId ? eq(providerApps.projectId, input.projectId) : isNull(providerApps.projectId),
      ),
    )
    .limit(1);

  const values = {
    provider: input.provider,
    projectId: input.projectId,
    ownership: input.ownership,
    clientId: input.clientId,
    encryptedClientSecret: input.encryptedClientSecret,
    callbackConfig: { redirectUri: input.redirectUri },
    scopes: [...input.scopes],
    approvalStatus: input.approvalStatus,
    metadata: input.metadata ?? {},
    updatedAt: new Date(),
  };

  const rows = existing[0]
    ? await db.update(providerApps).set(values).where(eq(providerApps.id, existing[0].id)).returning()
    : await db
        .insert(providerApps)
        .values({
          id: newUuidV7(),
          ...values,
          // A platform-managed app is the default for its provider. The partial unique
          // index allows only one, which is what stops two shared apps competing.
          isDefault: input.ownership === 'platform_managed',
        })
        .returning();

  const saved = rows[0];
  if (!saved) throw new ApiError('INTERNAL_ERROR', { message: 'Provider app upsert returned no row.' });
  return saved;
}

/**
 * Every configured application, for the admin screen.
 *
 * Deliberately projects away the encrypted secret. A list endpoint has no use for it, and
 * a repository that returns ciphertext by default invites it into a log.
 */
export async function listProviderApps(
  db: Database,
  projectId: string | null,
): Promise<
  Pick<
    ProviderApp,
    'id' | 'provider' | 'ownership' | 'clientId' | 'approvalStatus' | 'scopes' | 'updatedAt'
  >[]
> {
  return db
    .select({
      id: providerApps.id,
      provider: providerApps.provider,
      ownership: providerApps.ownership,
      clientId: providerApps.clientId,
      approvalStatus: providerApps.approvalStatus,
      scopes: providerApps.scopes,
      updatedAt: providerApps.updatedAt,
    })
    .from(providerApps)
    .where(projectId ? eq(providerApps.projectId, projectId) : isNull(providerApps.projectId))
    .orderBy(desc(providerApps.updatedAt));
}

/** Record where a platform's review has got to (plan §63). */
export async function setApprovalStatus(
  tx: Database | Transaction,
  providerAppId: string,
  approvalStatus: string,
): Promise<void> {
  await tx
    .update(providerApps)
    .set({ approvalStatus, updatedAt: new Date() })
    .where(eq(providerApps.id, providerAppId));
}

export async function deleteProviderApp(db: Database, providerAppId: string): Promise<boolean> {
  const rows = await db
    .delete(providerApps)
    .where(eq(providerApps.id, providerAppId))
    .returning({ id: providerApps.id });

  return rows.length > 0;
}
