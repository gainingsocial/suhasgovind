import { z } from 'zod';

/**
 * Canonical provider identifiers (plan §62).
 *
 * These strings are part of the public API contract: they appear in request bodies,
 * response payloads, webhook events, error codes and the `provider` text column on
 * `provider_apps`, `social_connections` and `social_destinations`. Renaming one is a
 * breaking change (plan §69), so they are deliberately plain and unabbreviated.
 *
 * The database stores `provider` as `text` rather than a Postgres enum. That is the right
 * call here even though the status enums are real enums: provider rollout is continuous
 * (plan P14, "no rewrite-oriented phases"), and gating every new adapter behind
 * `ALTER TYPE` would put a migration in the critical path of shipping one. The state
 * machines get an enum because a typo there silently breaks the target lease; a typo in a
 * provider name fails loudly at the registry instead.
 *
 * Meta's three surfaces are separate providers, not one. They have different destination
 * models, different capabilities and different publishing constraints even though a
 * single Meta app authorizes all three (plan §23). Collapsing them is the mistake that
 * forces a rewrite at provider four (see the comment in `schema/connections.ts`).
 */
export const PROVIDER_NAMES = [
  /** In-process reference adapter. Proves the engine with zero network (plan §49). */
  'mock',

  // ---- Phase 1: engineering reference providers (plan §62.1) ----------------
  // Chosen because neither has an app-review gate, so the publishing spine can be
  // proven before any reviewer is involved.
  'bluesky',
  'telegram',

  // ---- Phase 2: commercial launch providers (plan §62.2) --------------------
  'linkedin',
  'facebook',
  'instagram',
  'threads',

  // ---- Phase 5: expansion (plan §62.2) --------------------------------------
  'tiktok',
  'youtube',
  'pinterest',
  'google_business_profile',
  'x',
  'discord',
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const ProviderNameSchema = z.enum(PROVIDER_NAMES).describe('Social platform identifier.');

const PROVIDER_NAME_SET: ReadonlySet<string> = new Set(PROVIDER_NAMES);

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === 'string' && PROVIDER_NAME_SET.has(value);
}

/**
 * Human-readable names for UI and error messages.
 *
 * Kept beside the identifiers so a new provider cannot be added without deciding how it
 * is displayed — a missing label is a compile error, not a `google_business_profile`
 * leaking into the dashboard.
 */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  mock: 'Mock Provider',
  bluesky: 'Bluesky',
  telegram: 'Telegram',
  linkedin: 'LinkedIn',
  facebook: 'Facebook Page',
  instagram: 'Instagram',
  threads: 'Threads',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
  google_business_profile: 'Google Business Profile',
  x: 'X',
  discord: 'Discord',
};

/**
 * Authentication strategies (plan §20).
 *
 * Declared per adapter so the connect flow branches on a strategy rather than assuming
 * OAuth. Bluesky uses `app_password` and Telegram uses `bot_token`; an OAuth-only model
 * would have to be torn open for either.
 *
 * Mirrors the `auth_strategy` Postgres enum. The two must agree — `authStrategy.test.ts`
 * has no way to check that across packages, so treat a change here as requiring a
 * migration.
 */
export const AUTH_STRATEGIES = [
  'oauth2',
  'oauth2_pkce',
  'oauth1',
  'manual_token',
  'bot_token',
  'webhook_url',
  'api_key',
  'app_password',
  'custom',
] as const;

export type AuthStrategy = (typeof AUTH_STRATEGIES)[number];

export const AuthStrategySchema = z.enum(AUTH_STRATEGIES);

/**
 * Whether a strategy needs a platform-registered application (client id + secret).
 *
 * This is what lets the product ship adapters whose provider approval has not landed:
 * a `false` here means the adapter is fully usable today, and the ones that are `true`
 * are exactly the entries tracked in PLATFORM_APPROVALS.md.
 */
export function requiresProviderApp(strategy: AuthStrategy): boolean {
  switch (strategy) {
    case 'oauth2':
    case 'oauth2_pkce':
    case 'oauth1':
      return true;
    // The end user supplies the credential directly; there is no app to register.
    case 'app_password':
    case 'bot_token':
    case 'manual_token':
    case 'api_key':
    case 'webhook_url':
    case 'custom':
      return false;
  }
}
