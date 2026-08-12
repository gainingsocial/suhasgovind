# Gaining Social — Agent-Native Unified Social API

> One API. Multiple social networks. Production-grade publishing.

Social execution infrastructure for software and AI agents — one API to connect, validate, publish,
schedule, observe, engage and optimize across every supported social platform.

The authoritative specification is [`UNIFIED_SOCIAL_API_MASTER_BUILD_PLAN.md`](./UNIFIED_SOCIAL_API_MASTER_BUILD_PLAN.md).
This README explains how to run what has been built.

---

## Repository layout

```
apps/
  api/                  Public REST API — Hono on Cloudflare Workers  (the product)
  web/                  Dashboard — Next.js App Router via OpenNext   (an API client)

workers/
  publisher/            Publish queue consumer + PublishWorkflow + RateLimiter DO
  customer-webhooks/    Outbound signed webhook delivery + retries + DLQ
  provider-webhooks/    Inbound provider webhook ingress (verify fast, process async)
  reconciler/           Cron safety net — repairs orphaned scheduled work

packages/
  contracts/            Zod schemas → OpenAPI → SDK types → MCP tool schemas
  domain/               State machines, aggregate reducer, content resolution
  db/                   Drizzle schema, SQL migrations, domain-shaped repositories
  crypto/               AES-GCM envelope encryption, API-key hashing, HMAC signing
  errors/               Agent-native error envelope + provider error taxonomy
  events/               Internal domain events (decoupled from webhook formatting)
  observability/        Request/trace IDs, structured logging, secret redaction
  platform-credentials/ Resolves + decrypts a registered platform app, shared by all runtimes
  provider-kit/         SocialProviderAdapter interface + certification harness
  providers/
    registry/           getAdapter(provider) — the only way the core reaches an adapter
    mock/               Reference adapter; proves the engine with zero network
    bluesky/            AT Protocol — app password, no approval gate
    telegram/           Bot API — bot token, no approval gate
    linkedin/           Posts API — OAuth, two-tier review
    meta-core/          Graph API plumbing shared by the Meta family
    facebook/           Facebook Pages
    instagram/          Instagram professional accounts
    threads/            Threads (separate app registration from the other two)
    x/                  X API v2 — OAuth 2.0 with PKCE, chunked media upload
    tiktok/             Content Posting API — audit gates public posting
    youtube/            Data API v3 — resumable upload, audit gates public uploads
    pinterest/          Pins API — boards are the destinations
    discord/            Bot token, no approval gate; channels are the destinations
    google-business-profile/  Local Posts — three API hosts, one adapter
  sdk-js/               TypeScript SDK — typed client, auto-retry, cursor pagination
  cli/                  `gs` — publish, preflight and inspect from a terminal or CI

infra/
  cloudflare/           Queue, Workflow, DO, R2, Hyperdrive provisioning notes
  supabase/             Project setup, roles, RLS policies

docs/
  adr/                  Architecture decision records — read before changing architecture
  architecture/         Deep dives on the parts whose ordering is load-bearing
  errors/               Every error code the API can return, and what to do about it
```

## Prerequisites

- Node.js >= 22.14
- pnpm 10.34+
- A Supabase project (or local Supabase for development)
- A Cloudflare account with Workers, Queues, Workflows, R2, Durable Objects and Hyperdrive

## Getting started

```bash
pnpm install
cp .env.example .env                     # fill in local values
node scripts/generate-secrets.mjs        # prints fresh KEK / pepper / signing roots

pnpm db:migrate                          # apply migrations to the dev database
pnpm --filter @gs/api dev                # API on http://127.0.0.1:8787
pnpm --filter @gs/web dev                # dashboard on http://127.0.0.1:3000
```

Verify the API is up:

```bash
curl http://127.0.0.1:8787/health
```

## The Phase-1 loop

What a developer can do end to end today:

```
create API key → create profile → connect a provider → upload media
  → preflight → POST /v1/posts → receive 202 → watch target status
  → receive signed webhook → view the post timeline
```

## Connecting an account

Two shapes, one flow. `POST /v1/connections/authorize` returns a `completion` field, and
a client branches on that rather than on a list of which platforms use OAuth:

```
completion: "redirect"     send the user to authorization_url; the provider calls back to
                           /v1/oauth/{provider}/callback and we redirect to your redirect_url

completion: "credential"   the platform has no consent screen (a Bluesky app password, a
                           Telegram bot token). Collect required_credential_fields and POST
                           them to /v1/connections/complete with the returned state
```

For a customer's own end users there is a hosted white-label page: `POST /v1/connect-sessions`
returns a signed, short-lived URL carrying your branding. They connect their accounts without
an account here and without seeing this dashboard.

## Turning a platform on

Every adapter reads its client id and secret from the `provider_apps` table at call time, so
an approval is a data change, not a deploy:

```
Dashboard → Platforms → paste client id + secret        (or POST /v1/provider-apps)
```

The page shows the exact redirect URI to register in the platform's developer console.
Bluesky, Telegram and Discord need none of this — they have no application to register,
which is why they are the reference providers. Progress on each application is tracked in
[`PLATFORM_APPROVALS.md`](./PLATFORM_APPROVALS.md).

Platforms that deliver webhooks also show a webhook URL and verify token on that page. Only
the Meta family (Facebook Pages, Instagram, Threads) has a certified webhook integration
today; the rest show no URL, because a URL that verifies nothing looks configured while
discarding everything it receives. See
[inbound provider webhooks](./docs/architecture/inbound-provider-webhooks.md).

TikTok and YouTube add a second step. Both restrict an unaudited client to private posting
*without failing the request*, so both adapters refuse to publish anything public until the
audit is recorded as `audited: true` on the provider app. Until then they report the limit
through capabilities, so a caller learns about it before publishing rather than by hunting
for a post nobody can see.

## Commands

| Command             | What it does                                                  |
| ------------------- | ------------------------------------------------------------- |
| `pnpm run ci`       | Everything CI runs. `run` is required — pnpm reserves bare `ci` |
| `pnpm test`         | Vitest across all packages                                     |
| `pnpm typecheck`    | TypeScript across the workspace                                |
| `pnpm boundaries`   | dependency-cruiser — enforces the layering rules in ADR-004    |
| `pnpm db:generate`  | Generate a migration from the Drizzle schema                   |
| `pnpm db:migrate`   | Apply pending migrations                                       |
| `pnpm openapi:emit` | Regenerate `packages/contracts/openapi/openapi.json`           |
| `pnpm docs:check`   | Verify `docs/errors/` documents every code the API can return  |
| `pnpm --filter @gs/api dev`        | Run the API Worker locally via wrangler         |
| `pnpm --filter @gs/api run deploy` | Deploy the API Worker. `run` required — pnpm reserves bare `deploy` |
| `pnpm format`       | Prettier                                                       |

## Non-negotiable rules

These come from plan §3 and §85. Violating them is a correctness or security bug, not a style
preference.

- **P1** Provider logic lives only in `packages/providers/*`. Enforced by `pnpm boundaries`.
- **P4** Queues are at-least-once. Every consumer must be idempotent (ADR-006).
- **P5** Tenant isolation is server-enforced. Never trust a caller-supplied ID without verifying
  ownership through `destination → connection → profile → environment → project`.
- **P9** Provider tokens are encrypted at the application layer and never logged (ADR-007).
- **P11/P15** The dashboard is an API client. No UI-only publishing logic.
- **Rule 2** Never invent provider API behaviour — consult the official current provider docs.
- **Rule 10** No long-running work in the request/response path.

## License

Proprietary. All rights reserved.
