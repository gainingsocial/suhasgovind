# ADR-002 — Public API Worker separate from Next.js

**Status:** Accepted
**Date:** 2026-08-07
**Plan reference:** §4.3, P11

## Context

The dashboard needs a backend. Next.js Route Handlers and Server Actions are already there. Putting
the public API inside the Next.js app would remove a deployment target.

But the API *is* the product. Customers integrate against it, agents call it, SDKs are generated from
it, and its latency and error envelope are commercial promises. A dashboard is a client of that
product.

## Decision

Ship two independently deployable Cloudflare Workers:

- `apps/api` — Hono + `@hono/zod-openapi`, versioned at `/v1`, holds the Queue/Workflow/R2/
  Hyperdrive/Durable Object bindings.
- `apps/web` — Next.js App Router via OpenNext.

The dashboard calls the same `/v1` endpoints external customers call. No publishing, scheduling,
connection or media business logic may live in Server Actions or Route Handlers (plan P11, P15).

## Consequences

- The API can be rate-limited, versioned, rolled back and scaled independently of the dashboard.
- A dashboard deploy cannot break customer publishing, and a Next.js major upgrade cannot change API
  latency.
- OpenAPI generation has one unambiguous source (plan §46).
- Cost: the dashboard pays a network hop and needs a token-exchange path from Supabase Auth session
  to API authorization. That is deliberate — it forces the dashboard to prove the API is complete.
- If a dashboard feature needs an endpoint that does not exist, the correct fix is to add the
  endpoint to `/v1`, not to reach around the API.

## Alternatives considered

**Everything in Next.js.** Faster initially; guarantees dashboard-only business logic within weeks,
which plan P11 forbids outright.

**API as a Next.js route + separate workers for async.** Splits business logic across two runtimes
with different lifecycles — the worst of both.
