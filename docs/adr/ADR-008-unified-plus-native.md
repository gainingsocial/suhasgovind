# ADR-008 — Unified core plus provider-native escape hatches

**Status:** Accepted
**Date:** 2026-08-07
**Plan reference:** P6, P16, §2.7, §11, §17, §43

## Context

A rigid single normalized schema eventually breaks, because provider capabilities genuinely differ
(plan §2.7). TikTok requires an explicit privacy selection. Instagram distinguishes feed posts,
carousels, stories and reels. LinkedIn distinguishes member and organization authors. YouTube needs
category and made-for-kids declarations. Pinterest needs a board.

Two failure modes bracket the design:

- **Lowest common denominator** — text plus one image, everywhere. Useless for the platforms
  customers actually care about.
- **Untyped passthrough blob** — `options: any`. No validation, no OpenAPI, no preflight, no agent
  usefulness. The customer must already know every platform's rules, which plan P16 forbids.

## Decision

**Stable unified primitives + explicit, typed provider-native extensions.** This is one of the most
important rules in the whole design.

### Canonical layer

`content.text`, `content.media_ids`, `content.link`, `publish_at`, `targets[]` — meaningful on every
provider.

### Resolution order (plan §11.2)

```
canonical post content
  → target content override        (per-destination text/media)
  → provider-specific options      (targets[].options.<provider>)
  → provider capability/default resolver
```

Deterministic, and identical in preflight and in publish.

### Typed extensions

Provider options are a discriminated union, not a blob:

```ts
type ProviderOptions =
  | { provider: 'instagram'; data: InstagramPostOptions }
  | { provider: 'linkedin';  data: LinkedInPostOptions }
  | { provider: 'bluesky';   data: BlueskyPostOptions };
```

At the REST boundary this surfaces as `options: { instagram: { … } }` with full OpenAPI schemas. Each
shape is owned and validated by its adapter.

### Capability registry is a product feature, not documentation

`GET /v1/platforms/{provider}/capabilities` returns generic capability.
`GET /v1/destinations/{id}/capabilities` returns **effective** capability for one connected
destination — which differs by granted scopes, account type, subscription, provider approval, region
and rollout (plan §17).

Effective capability is what an agent must consult. Generic capability is a catalog.

### Preflight shares the pipeline

`POST /v1/posts/preflight` accepts **the same body** as `POST /v1/posts` and runs the same schema,
ownership, health, scope, capability, text, media, options, compliance and schedule checks — with no
publish side effects (plan §18). Anything preflight accepts, publish accepts.

## Consequences

- Adding a provider-specific feature is additive: extend that adapter's option schema and capability
  declaration. The core does not change.
- Users and agents never need to memorize platform rules (plan P16) — they ask the capability
  registry, and preflight tells them precisely what is wrong with a stable `code` and an
  `agent_action` (plan §16).
- Capability payloads are versioned (`schema_version`, `adapter_version`, `effective_at`) so a
  cached client can detect staleness (plan §80).
- Cost: every adapter must maintain real capability metadata, and it must be *true*. Stale capability
  data is worse than none, so certification (plan §65) checks it.

## Alternatives considered

**Normalize everything.** Breaks on the first platform whose flagship format has no analogue.

**Passthrough everything.** Abandons preflight, OpenAPI, SDK types and agent-readability — the
product's actual differentiators.
