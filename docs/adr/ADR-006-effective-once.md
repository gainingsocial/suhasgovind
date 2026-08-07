# ADR-006 — Effective-once publishing

**Status:** Accepted
**Date:** 2026-08-07
**Plan reference:** P4, §25, §26, §77

## Context

Duplicate social posts are the most visible, least forgivable failure this product can produce. They
are also structurally hard to prevent:

- Cloudflare Queues deliver **at least once**.
- Customers and agents retry on timeout.
- Social providers mostly do **not** offer idempotency keys.
- Ayrshare publicly documents that a provider can return an apparent failure *after* the content was
  actually published (plan §2.2). A blind retry there creates a real duplicate.
- Ayrshare also documents that simultaneous duplicate requests can race before an idempotency key is
  registered (plan §2.2) — an explicit improvement target for us.

Exactly-once across third-party APIs that do not themselves guarantee it is not achievable. Promising
it would be a lie.

## Decision

Promise **effectively-once publishing with duplicate prevention and reconciliation**, implemented as
four independent layers. Each layer catches what the previous one cannot.

### Layer 1 — Request idempotency (atomic)

`INSERT ... ON CONFLICT DO NOTHING` into `idempotency_keys` inside the create-post transaction,
*before* any downstream work exists. The unique index is the race-prevention mechanism — not an
application-level check-then-act.

- Same key, same request hash → return the original result.
- Same key, different request hash → `409 IDEMPOTENCY_KEY_REUSED`.

This closes the concurrent-duplicate race Ayrshare documents.

### Layer 2 — Target execution lease

A queue message never grants the right to publish. The consumer must win a conditional update:

```sql
UPDATE post_targets
SET status='publishing', lease_id=$1, lease_expires_at=$2, attempt_count=attempt_count+1
WHERE id=$3
  AND status IN ('queued','retryable_failed','scheduled')
  AND (lease_expires_at IS NULL OR lease_expires_at < now())
RETURNING *;
```

No row returned → another consumer owns it, or it is already terminal → **acknowledge and exit**.
Redelivery is therefore free, and a stuck consumer self-heals when its lease expires.

### Layer 3 — Content fingerprint (advisory)

`sha256(provider + destination + normalized content + media identity + time bucket)`. Deliberately
**not** an inflexible 24-hour prohibition: configurable window, `allow_duplicate: true` escape hatch,
per-provider policy (plan §25 Layer 3).

### Layer 4 — Reconciliation before ambiguous retry

If a call times out or fails in a way that cannot distinguish "not published" from "published but
the response was lost", the target becomes `unknown_reconciliation_required` — **not**
`retryable_failed`. A reconciliation job calls the adapter's optional `findPossibleDuplicate` and
retries only when the evidence says nothing was published. Without such evidence the target stays in
that state and surfaces to the customer rather than risking a duplicate.

## Consequences

- Correctness lives in the database, not in queue semantics or consumer discipline.
- Every provider adapter should implement `findPossibleDuplicate` where the provider offers a
  recent-posts or status endpoint; Layer 4 degrades to "surface it, don't retry it" where it cannot.
- A multi-network post is never one atomic external transaction. Partial success is a first-class
  outcome: aggregate `partially_published`, and `POST /v1/posts/{id}/retry` defaults to
  `scope: "failed_targets"` and never resubmits a successful target (plan §26).
- Tests for all four layers are mandatory Phase-1 gates, including the two-concurrent-requests case.

## Alternatives considered

**Trust queue delivery.** At-least-once means this produces duplicates under normal operation.

**Advisory locks / Durable Object mutex only.** Coordination without durable state: a restart or
eviction loses the record of what already ran. The lease is durable because it lives on the row.

**Blind retry on timeout.** Directly produces the duplicate Ayrshare warns about.
