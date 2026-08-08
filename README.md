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
  provider-kit/         SocialProviderAdapter interface + certification harness
  providers/
    registry/           getAdapter(provider) — the only way the core reaches an adapter
    mock/               Reference adapter; proves the engine with zero network
    bluesky/            First real provider (AT Protocol)
  sdk-js/               Generated TypeScript SDK

infra/
  cloudflare/           Queue, Workflow, DO, R2, Hyperdrive provisioning notes
  supabase/             Project setup, roles, RLS policies

docs/
  adr/                  Architecture decision records — read before changing architecture
  architecture/         Diagrams and deep dives
  platforms/            Per-provider integration + compliance notes
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
  → receive signed webhook → view request/post timeline
```

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
| `pnpm --filter @gs/api dev`    | Run the API Worker locally via wrangler             |
| `pnpm --filter @gs/api deploy` | Deploy the API Worker to Cloudflare                 |
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
