import { newUuidV7 } from '@gs/contracts/ids';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { featureFlags, type FeatureFlag } from '../schema/platform.js';
import { projectEnvironments } from '../schema/tenancy.js';

/**
 * Environment execution settings and feature flags (plan §45, §49).
 *
 * Both answer the same shape of question — "is this switched on, here?" — and both are
 * read on the publish path, so they share a repository and, where it matters, a query.
 */

export interface EnvironmentExecutionSettings {
  projectEnvironmentId: string;
  kind: 'test' | 'live';
  /**
   * Simulation mode (plan §49). The full pipeline runs and nothing reaches a provider.
   *
   * Not the same thing as `kind = 'test'`: a test environment may deliberately publish to
   * a real sandbox account, and a live environment may be put into simulation during an
   * incident to stop outbound posting without taking the API down.
   */
  simulationMode: boolean;
  allowTestKeyLiveConnections: boolean;
  settings: Record<string, unknown>;
}

/**
 * Read the settings that govern how an environment executes.
 *
 * Read fresh per publish rather than cached on the message. A queue message may be days
 * old by the time it runs — a scheduled post is the normal case — and simulation switched
 * on after the message was enqueued must still be honoured, or the switch does not
 * actually stop anything.
 */
export async function findEnvironmentSettings(
  db: Database,
  projectEnvironmentId: string,
): Promise<EnvironmentExecutionSettings | null> {
  const rows = await db
    .select({
      projectEnvironmentId: projectEnvironments.id,
      kind: projectEnvironments.kind,
      simulationMode: projectEnvironments.simulationMode,
      allowTestKeyLiveConnections: projectEnvironments.allowTestKeyLiveConnections,
      settings: projectEnvironments.settings,
    })
    .from(projectEnvironments)
    .where(eq(projectEnvironments.id, projectEnvironmentId))
    .limit(1);

  return rows[0] ?? null;
}

export async function setSimulationMode(
  db: Database,
  projectEnvironmentId: string,
  simulationMode: boolean,
): Promise<void> {
  await db
    .update(projectEnvironments)
    .set({ simulationMode, updatedAt: new Date() })
    .where(eq(projectEnvironments.id, projectEnvironmentId));
}

// ---------------------------------------------------------------------------
// Feature flags (plan §45)
// ---------------------------------------------------------------------------

export interface FlagScope {
  organizationId?: string | null;
  projectId?: string | null;
  projectEnvironmentId?: string | null;
}

export interface ResolvedFlag {
  key: string;
  enabled: boolean;
  /** Which scope decided it, for the "why is this off?" question. */
  decidedBy: 'environment' | 'project' | 'organization' | 'global' | 'default';
  value: Record<string, unknown> | null;
  rolloutPercentage: number | null;
}

/**
 * Specificity of the scope a flag row is defined at. Higher wins.
 *
 * Resolution is most-specific-first: environment → project → organization → global. That
 * ordering is what lets a provider feature be disabled for one customer without disabling
 * it for everyone, and enabled in staging before production (plan §45).
 */
function specificity(row: FeatureFlag): number {
  if (row.projectEnvironmentId) return 3;
  if (row.projectId) return 2;
  if (row.organizationId) return 1;
  return 0;
}

function scopeName(row: FeatureFlag): ResolvedFlag['decidedBy'] {
  if (row.projectEnvironmentId) return 'environment';
  if (row.projectId) return 'project';
  if (row.organizationId) return 'organization';
  return 'global';
}

/**
 * Resolve every flag that applies to a scope, in one query.
 *
 * One query rather than four cascading lookups: flags are read on the publish path and on
 * every capability response, and four sequential round trips to a database a region away
 * is not a cost worth paying for a boolean.
 */
export async function resolveFlags(db: Database, scope: FlagScope): Promise<Map<string, ResolvedFlag>> {
  const rows = await db
    .select()
    .from(featureFlags)
    .where(
      or(
        // Global rows apply to everyone.
        and(
          isNull(featureFlags.organizationId),
          isNull(featureFlags.projectId),
          isNull(featureFlags.projectEnvironmentId),
        ),
        scope.organizationId ? eq(featureFlags.organizationId, scope.organizationId) : sql`false`,
        scope.projectId ? eq(featureFlags.projectId, scope.projectId) : sql`false`,
        scope.projectEnvironmentId
          ? eq(featureFlags.projectEnvironmentId, scope.projectEnvironmentId)
          : sql`false`,
      ),
    );

  const winners = new Map<string, FeatureFlag>();
  for (const row of rows) {
    const current = winners.get(row.key);
    if (!current || specificity(row) > specificity(current)) winners.set(row.key, row);
  }

  const resolved = new Map<string, ResolvedFlag>();
  for (const [key, row] of winners) {
    resolved.set(key, {
      key,
      enabled: row.enabled,
      decidedBy: scopeName(row),
      value: row.value,
      rolloutPercentage: row.rolloutPercentage,
    });
  }

  return resolved;
}

/**
 * Is a flag on for a specific subject?
 *
 * `subjectId` makes a percentage rollout deterministic: the same connection or profile
 * lands on the same side of the split on every call. A random draw per call would flip a
 * feature on and off between a preflight and the publish it validated, which is the one
 * outcome a rollout must never produce.
 */
export async function isFlagEnabled(
  db: Database,
  key: string,
  scope: FlagScope,
  subjectId?: string,
): Promise<boolean> {
  const flags = await resolveFlags(db, scope);
  return evaluateFlag(flags.get(key), subjectId);
}

export function evaluateFlag(flag: ResolvedFlag | undefined, subjectId?: string): boolean {
  // An undefined flag is off. A feature nobody has switched on is not on (plan §45).
  if (!flag || !flag.enabled) return false;
  if (flag.rolloutPercentage === null || flag.rolloutPercentage >= 100) return true;
  if (flag.rolloutPercentage <= 0) return false;
  if (!subjectId) return false;

  return bucketOf(`${flag.key}|${subjectId}`) < flag.rolloutPercentage;
}

/**
 * Deterministic 0–100 bucket from a string.
 *
 * FNV-1a: not cryptographic, and does not need to be. What it needs is to be stable
 * across processes and deploys, which rules out anything seeded per isolate.
 */
function bucketOf(input: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return ((hash >>> 0) % 10_000) / 100;
}

/**
 * Flag key for a provider, or for one feature of a provider (plan §45).
 *
 * `provider:instagram` disables Instagram entirely; `provider:instagram:reels` disables
 * only Reels. That is the distinction §45 exists for — "disable a failing feature without
 * taking down the whole provider".
 */
export function providerFlagKey(provider: string, feature?: string): string {
  return feature ? `provider:${provider}:${feature}` : `provider:${provider}`;
}

export interface FlagBlock {
  key: string;
  decidedBy: ResolvedFlag['decidedBy'];
}

/**
 * Is a provider or provider feature switched **off**?
 *
 * Kill-switch semantics, and deliberately the inverse of {@link evaluateFlag}:
 *
 *   absent                  allowed — a provider nobody has touched works
 *   present, enabled=false  blocked
 *   present, enabled=true   allowed
 *
 * Two functions rather than one with a `defaultValue` parameter, because the two default
 * directions are not a configuration detail, they are opposite failure modes. A rollout
 * that defaults on ships an untested feature to everyone; a kill switch that defaults off
 * takes every provider down the moment the flags table is empty — which is its state in
 * every fresh environment, including the one a customer just created.
 *
 * The more specific key wins: disabling `provider:instagram` blocks Reels too, but
 * disabling `provider:instagram:reels` leaves the rest of Instagram publishing.
 */
export function providerBlockedBy(
  flags: Map<string, ResolvedFlag>,
  provider: string,
  feature?: string,
): FlagBlock | null {
  const keys = feature
    ? [providerFlagKey(provider, feature), providerFlagKey(provider)]
    : [providerFlagKey(provider)];

  for (const key of keys) {
    const flag = flags.get(key);
    if (flag && !flag.enabled) return { key, decidedBy: flag.decidedBy };
  }

  return null;
}

export interface UpsertFlagInput extends FlagScope {
  key: string;
  description?: string | null;
  enabled: boolean;
  rolloutPercentage?: number | null;
  value?: Record<string, unknown> | null;
}

/** Create or update a flag at exactly one scope. */
export async function upsertFeatureFlag(db: Database, input: UpsertFlagInput): Promise<void> {
  await db
    .insert(featureFlags)
    .values({
      id: newUuidV7(),
      key: input.key,
      description: input.description ?? null,
      organizationId: input.organizationId ?? null,
      projectId: input.projectId ?? null,
      projectEnvironmentId: input.projectEnvironmentId ?? null,
      enabled: input.enabled,
      rolloutPercentage: input.rolloutPercentage ?? null,
      value: input.value ?? null,
    })
    .onConflictDoUpdate({
      target: [
        featureFlags.key,
        featureFlags.organizationId,
        featureFlags.projectId,
        featureFlags.projectEnvironmentId,
      ],
      set: {
        enabled: input.enabled,
        rolloutPercentage: input.rolloutPercentage ?? null,
        value: input.value ?? null,
        description: input.description ?? null,
        updatedAt: new Date(),
      },
    });
}
