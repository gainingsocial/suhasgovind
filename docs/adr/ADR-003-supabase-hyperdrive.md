# ADR-003 — Supabase Postgres reached via Hyperdrive

**Status:** Accepted
**Date:** 2026-08-07
**Plan reference:** §5.1–5.3, §6

## Context

The publishing engine needs guarantees that only a real relational database provides:

- a unique index that atomically reserves an idempotency key before any downstream work exists
  (plan §77),
- a conditional `UPDATE ... RETURNING` that leases a publish target so exactly one consumer executes
  it (plan §25 Layer 2),
- multi-row transactions creating a post and its targets together.

Workers, however, are short-lived isolates. Opening a fresh Postgres connection per request is both
slow and a connection-pool exhaustion hazard.

## Decision

- **Supabase PostgreSQL is the single source of truth.** Not Durable Objects, not queues, not R2.
- Workers connect through **Cloudflare Hyperdrive**, which pools and caches connections at the edge.
- Use `postgres` (postgres.js) as the driver and **Drizzle ORM** for typed schema and query building.
- Drop to raw SQL for transactions, locking and atomic idempotency where explicitness beats
  abstraction (plan §5.2).
- Workers authenticate as a **dedicated least-privilege application role**, not `postgres` and not
  Supabase's `service_role`.
- **RLS is enabled on every browser-exposed table** and constrained by organization membership,
  project membership, role, environment and profile.

Backend Workers still perform explicit ownership checks in application code even though they bypass
RLS via the application role. Defense in depth (plan §5.3, P5).

## Consequences

- Idempotency and target leasing are enforced by the database, so correctness does not depend on
  queue delivery semantics.
- Hyperdrive is a hard dependency of the API and publisher Workers. Local development uses a direct
  connection string; the driver interface is identical.
- Never use the Supabase `service_role` key as the public API's authorization mechanism (plan §5.2).
  Authorization is API-key scopes plus explicit tenant checks.
- Durable Objects hold *coordination* state (rate-limit budgets, leases), never durable business
  data (plan §6.4).

## Alternatives considered

**Cloudflare D1.** Attractive locality, but the concurrency and transactional guarantees the
publishing spine needs are exactly where SQLite-at-the-edge is weakest.

**Supabase client library from the Worker (PostgREST).** No real transactions, no `SELECT ... FOR
UPDATE`, no conditional-lease pattern.

**Postgres direct without Hyperdrive.** Works, but connection setup cost and pool pressure at edge
concurrency make it a scaling cliff rather than a slope.
