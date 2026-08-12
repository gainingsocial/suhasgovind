# The connection health engine

Plan §42. Keeping credentials working, and being clear when they cannot be kept working.

Almost everything a customer experiences as "it just stopped posting" starts here. A token
that expires unnoticed produces a failed publish, and a failed publish is the worst possible
place to learn about it: the post is late, the customer finds out from its absence, and the
only remaining options are a delayed retry or an apology.

## Refresh before expiry, not on failure

`gs-connection-health` runs hourly and refreshes anything expiring within 24 hours. That
gives roughly twenty-four attempts before a token actually dies, so a multi-hour provider
outage costs nobody a connection.

Rows come back most-urgent-first and the batch is bounded, so a truncated sweep leaves behind
whatever has the most time left.

Refreshes run **sequentially**, not concurrently. Fifty parallel refreshes against one
provider is a burst that provider will rate limit — and being rate limited on the *refresh*
endpoint is how a maintenance sweep becomes an outage.

## The hazard everything is built around

Most OAuth providers invalidate the old refresh token the instant a new one is issued.

Two workers refreshing the same connection therefore does not produce a harmless duplicate.
The slower one writes a token the provider has already revoked, and the connection breaks
permanently — while looking fine in the database.

So:

- **A per-connection lock**, taken as a conditional `UPDATE` (the same shape as the publish
  target lease). A worker that cannot take it returns `locked` and moves on. This is not an
  optimization and cannot be skipped.
- **The lock is always released**, including after a throw. A lock held by a crashed worker
  blocks every later sweep until it times out, while the credential it protects expires on
  schedule regardless.
- **Both tokens are written in one transaction.** Writing the new access token and then
  failing to write the new refresh token leaves a connection that works today and can never
  refresh again — the worst outcome available, because it looks healthy.

## What each outcome means

| Outcome            | When                                                   |
| ------------------ | ------------------------------------------------------ |
| `refreshed`        | new credentials issued and stored                      |
| `still_valid`      | provider returned the same credential; no write        |
| `locked`           | another worker holds it — normal, not a failure        |
| `deferred`         | transient provider failure; try again next sweep       |
| `reauth_required`  | no automated recovery exists; the customer was told    |
| `not_refreshable`  | nothing to refresh with                                |

### Escalation branches on disposition, not retryability

`AUTH_EXPIRED` is marked *retryable* in the taxonomy (plan §79) precisely because a refresh
is supposed to be attempted first — but this code **is** that attempt. Reading its
retryability here would defer the one failure only a human can fix, and the connection would
sit in `refresh_due` until the token died, silently.

`blocked_on_connection` is the disposition meaning "no automated recovery exists", and only
it escalates. Everything else — a 503, a rate limit — is a provider having a bad minute.
Telling a customer to reconnect a working account is *destructive*: once they do, the old
token really is revoked.

### The refresh token's own expiry is checked first

Before taking the lock and before any network call. The answer is already known, and asking
the provider anyway would be a guaranteed-failing call on every sweep, for every affected
connection, forever.

### An expiring credential with no refresh token

Not an error — a Bluesky app password and a Telegram bot token never expire. But an
*expiring* credential with no way to renew it will stop working on a known date, so the
connection is marked `refresh_due` and the customer can hear about it beforehand rather than
afterwards.

## Telling the customer, exactly once

`connection.reauth_required` fires only when the health transition actually moved.

An alert that fires on every sweep of an already-broken connection gets muted, and the next
real one is then missed. The same rule governs the inbound-webhook path, which can detect the
same condition from the provider's side.

A `reauth_required` connection is also excluded from the due query, so a dead connection is
not retried against the provider forever.

## Reading the history

```
GET /v1/connections/{id}/health
```

Every transition, newest first: what changed, why, and the normalized provider code behind
it. This exists because the current `health` value alone cannot answer "why did this stop
working?" — by the time anyone asks, the transition that explains it has been overwritten by
whatever happened since.

## Two paths to the same conclusion

Connection health is written from three places, all through `setConnectionHealth`, which is
conditional and reports whether anything moved:

- **this worker**, proactively, before expiry;
- **inbound provider webhooks**, when the platform tells us a grant was revoked;
- **the publisher**, when a live publish hits an auth failure.

All three are at-least-once, which is why the conditional transition matters: three
independent detections of the same revocation still produce one customer alert.

## Related

- Plan §41, §42, §79
- [Inbound provider webhooks](./inbound-provider-webhooks.md)
- [ADR-007 — token encryption](../adr/ADR-007-token-encryption.md)
