# ADR-005 — Cloudflare Workflows for orchestration, Queues for execution

**Status:** Accepted
**Date:** 2026-08-07
**Plan reference:** P3, §6.2, §6.3, §27, §30

## Context

Publishing one logical post to five networks is a durable, long-running, partially-failing process.
It may wait for approval, sleep until a scheduled time hours or weeks away, retry individual
destinations on different backoff schedules and end in a mixed outcome.

Two anti-patterns to avoid:

- **Holding the HTTP request open** until every network answers (plan P3). One slow provider then
  defines the API's latency, and a client disconnect becomes data loss.
- **A per-minute cron that scans for due posts** (plan §6.3). This is a polling scheduler wearing a
  workflow costume: it does not survive partial failure and it scales with table size, not with
  work.

Postiz's public use of Temporal is the strongest open-source signal that this is a durable-workflow
problem, not CRUD plus cron (plan §2.4).

## Decision

Split orchestration from execution.

**Cloudflare Workflows** own the per-post lifecycle:

```
create → preflight → [waitForEvent(approval)] → sleepUntil(publish_at)
       → revalidate → fan out targets → observe terminal events → aggregate status
```

**Cloudflare Queues** own per-unit execution: one message per publish target, plus webhook delivery,
token refresh, media probing, analytics sync, account health and reconciliation (plan §30).

**Durable Objects** are coordination primitives only — provider/account rate-limit budgets, refresh
serialization (plan §6.4, §29).

**Cron Triggers** run a reconciler only: find scheduled posts past `publish_at` with no live work and
repair them. Cron is a safety net, never the primary scheduler (plan §27).

Queue messages carry **IDs and a trace ID, never payloads** (plan §30). Authoritative state is loaded
from Postgres by the consumer, so a message replayed after a state change reads current truth.

## Consequences

- `POST /v1/posts` returns `202` in milliseconds and reliability no longer depends on the client's
  connection.
- Queues are **at-least-once** (plan P4). Every consumer must be idempotent — enforced by the target
  lease in ADR-006.
- Scheduling accuracy comes from `sleepUntil`, which costs nothing while sleeping.
- Cost: two async substrates to reason about. Mitigated by keeping the rule crisp — *Workflows decide
  what happens next; Queues do one thing once.*
- Portability: domain boundaries stay clean enough that orchestration could move to Temporal without
  touching provider adapters (plan §2.4).

## Alternatives considered

**Self-hosted Temporal.** More powerful, materially more operational burden for a small team, and it
would sit outside the edge runtime the rest of the product uses.

**Queues only, with delayed messages for scheduling.** Workable for simple delays, but approval waits,
revalidation and compensation sequences turn into hand-rolled state machines in message payloads.

**Cron only.** Rejected explicitly by plan §6.3.
