# ADR-009: Hyperdrive query caching is disabled

**Status:** Accepted · 2026-08-09

## Context

Cloudflare Hyperdrive caches non-mutating query results by default, with a default max age
of 60 seconds. For a read-heavy application this is exactly what you want: it removes a
round trip to a database that may be a continent away.

This is not a read-heavy application in the relevant sense. Almost every read here exists
to decide whether to perform an irreversible write:

- the reconciler polls for scheduled posts whose time has arrived, then publishes them
- the publisher reads connection health and credentials, then calls a social platform
- the API reads a destination's ownership, then creates a post against it
- the webhook worker reads a delivery's retry state, then POSTs to a customer

A stale read in any of those produces a wrong action, not a slightly outdated page.

We found this the hard way. The reconciler ran every minute, connected successfully,
and reported `scheduledPosts: 0` while a post five minutes overdue sat in the table. The
cron's poll is the same query every time, so Hyperdrive served the cached empty result
back indefinitely. Scheduled posts would never have fired in production, and — worse —
nothing would have surfaced it. The post simply sits there.

## Decision

Query caching is disabled on every Hyperdrive configuration.

```
PATCH /accounts/{account}/hyperdrive/configs/{id}
{ "caching": { "disabled": true } }
```

Connection pooling — the reason Hyperdrive is here at all (ADR-003) — is unaffected. Only
result caching is off.

## Consequences

- Every query reaches Postgres. Latency rises by roughly one round trip on reads that
  would previously have hit the cache.
- Correctness is unconditional. No code has to reason about whether the row it just read
  reflects a write made a moment ago by another Worker.
- **This setting is not expressed in `wrangler.jsonc`.** It lives on the Hyperdrive
  configuration itself, so a config recreated by hand will silently default back to
  caching enabled — and the symptom is scheduled posts quietly never publishing. Any new
  Hyperdrive config must have caching disabled at creation, and `infra/cloudflare` should
  be the place that records it.

## Alternatives considered

**Leave caching on and set a short max age.** Rejected: it narrows the window without
closing it, and the failure it permits is invisible. A one-second stale read still lets a
scheduled post be missed for a cycle, and still lets two workers act on the same
pre-lease state.

**Disable caching only on the reconciler's config.** Rejected: it would need a second
Hyperdrive configuration purely to hold a different cache setting, and the publisher and
API have the same read-then-write shape. The distinction would be arbitrary and easy to
get wrong when a fifth worker is added.

**Add a cache-busting parameter to polling queries.** Rejected: it makes correctness
depend on every future query author remembering to opt out, which is the wrong default
for a property this load-bearing.
