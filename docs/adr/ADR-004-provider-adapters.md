# ADR-004 — Provider adapter architecture

**Status:** Accepted
**Date:** 2026-08-07
**Plan reference:** P1, P7, §19, §20, §65, §75

## Context

The failure mode that kills unified APIs is provider logic leaking into the core. It starts as one
`if (provider === 'instagram')` in the publish path and ends as a publishing engine nobody can
change without regression-testing fifteen networks.

Providers also differ in ways a single OAuth-shaped model cannot absorb: Discord uses webhook URLs,
Telegram uses bot tokens, Bluesky uses app passwords, X uses OAuth2 with PKCE, Meta uses long-lived
token exchange.

## Decision

Every provider implements one interface, `SocialProviderAdapter` (plan §19), exposing `capabilities`,
`auth`, `destinations`, `publishing`, `normalizeError` and optional `verifyWebhook`.

Rules, enforced by dependency-cruiser (`pnpm boundaries`):

1. **No route handler, worker or workflow imports a concrete provider package.** Adapters are
   resolved through the `@gs/providers` registry.
2. **No provider SDK is importable outside `packages/providers/*`.**
3. **An adapter is a leaf.** It may depend on `@gs/provider-kit`, `@gs/contracts` and `@gs/errors`.
   It may not depend on the database, the domain layer, billing or the UI.
4. **Authentication strategy is declared, not assumed** — one of `oauth2`, `oauth2_pkce`, `oauth1`,
   `manual_token`, `bot_token`, `webhook_url`, `api_key`, `app_password`, `custom` (plan §20).
5. **The adapter owns validation and capability metadata** (plan P7). The core never hardcodes a
   character limit.
6. **Connection ≠ destination** (plan §8.5). One authorization may expose many publishing targets.

An adapter is not "supported" until it passes the certification checklist in plan §65 (Rule 13).

## Consequences

- Adding a provider is additive work in one directory plus a registry entry.
- The core publishing engine can be tested end to end against the mock adapter with no network.
- Shared low-level clients are allowed (a Meta Graph HTTP client used by Facebook, Instagram and
  Threads) but the *public adapters stay distinct* — no giant `MetaAdapter` with branching (plan §2
  Phase 2).
- Cost: some duplication between sibling adapters. Accepted — duplication is cheaper than coupling
  three product surfaces to one class.

## Alternatives considered

**Per-provider bespoke services.** Every provider becomes a rewrite; the abstraction is never
proven.

**One normalized model with no escape hatch.** See ADR-008 — provider capabilities genuinely differ,
and forcing a lowest common denominator makes the API useless for the platforms customers care most
about.
