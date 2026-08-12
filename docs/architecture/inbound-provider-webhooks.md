# Inbound provider webhooks

Plan §34. How a platform tells us something changed, and what we do about it.

This is the counterpart to [outbound customer webhooks](../../README.md#the-phase-1-loop):
those are events we send, these are events we receive.

## The contract with every provider

```
1. verify the signature
2. persist the event, deduplicated
3. enqueue processing
4. acknowledge
```

Nothing else happens before step 4, and the ordering is the entire design.

Providers acknowledge-or-retry on short deadlines — Meta retries with decreasing frequency
for 36 hours and then drops the notification. A handler that resolves connections and
updates health *before* replying turns one slow query into a redelivery storm, arriving
during exactly the incident that produced the webhook in the first place.

The event row is committed before the enqueue, and the enqueue happens in `waitUntil`. If
the queue is unavailable the row is still there, and a cron sweep picks it up 15 minutes
later. The reverse order would trade a rare lost message for a routine slow acknowledgment,
and the slow acknowledgment is what causes the storm.

## Endpoints

```
POST /webhooks/providers/{provider}                  the shared platform application
POST /webhooks/providers/{provider}/{provider_app_id} an enterprise's own application
GET  /webhooks/providers/{provider}                  subscription handshake, where used
```

Unversioned on purpose. The URL is typed into a developer console once and stays there for
years; pinning it to `/v1` would mean an API version bump silently stops a provider from
reaching us — and a webhook that stops arriving reports no error anywhere.

A webhook carries no tenant context, so the **platform-managed** application is the
default. An enterprise running their own Meta or LinkedIn app registers the app-scoped
path, because their deliveries are signed with their secret and the platform default would
reject every one of them. Both URLs, and the verify token, are shown on the dashboard's
Platforms page and returned by `GET /v1/provider-apps`.

## Verification lives in the adapter

`SocialProviderAdapter.verifyWebhook` is optional and present only for providers with a
certified webhook integration. It receives the exact bytes as received — re-serializing
would break every HMAC scheme in use, since no two JSON encoders agree on key order and
unicode escaping — and returns either a handshake response or a batch of normalized events.

A provider without `verifyWebhook` returns **404**, not 501. An endpoint that exists but
verifies nothing is a worse answer than one that does not exist, and a provider will retry
a 5xx indefinitely.

### Currently implemented

| Provider           | Scheme                                                     |
| ------------------ | ---------------------------------------------------------- |
| Facebook Pages     | `X-Hub-Signature-256`, HMAC-SHA256 over the raw body       |
| Instagram          | as above (same Meta protocol)                              |
| Threads            | as above, separate app registration and therefore secret   |

Everything else deliberately has no `verifyWebhook`. Per Rule 2 we do not implement a
signature scheme we cannot read the current official documentation for, and per Rule 14 a
scheme we cannot verify fails safely rather than being guessed at — a guessed construction
would either reject everything real or, far worse, accept something forged.

## Why unverified requests still get a 200

A forged or misconfigured request is recorded with `signature_verified = false` and
acknowledged with an empty 200. It is never processed.

Returning 401 would tell whoever sent it that the endpoint exists, is live, and which
secret they failed to guess — worth more to an attacker than the rejection costs them. The
stored rejections are also the signal that a secret was rotated on the provider's side
without being rotated here, which otherwise presents as webhooks that simply stopped
arriving, with no error anywhere.

## Deduplication

Plan §10.4. Two partial unique indexes on `provider_events`:

```
(provider, provider_event_id)   when the provider supplies a stable id
(provider, fingerprint)         when it does not
```

Exactly one is ever set. Writing both would let one event be stored twice under two
different dedupe keys.

Meta supplies no per-event identifier, so Meta events are fingerprinted. The fingerprint
covers the *normalized event*, not the request body: one POST carries many changes, and
keying on the body would make a batch containing one already-seen change look entirely new.

The insert is `ON CONFLICT DO NOTHING ... RETURNING`, with no conflict target so both
indexes apply. An empty return is the duplicate signal. A read-then-write would let two
concurrent redeliveries of the same event both observe "not present" and both proceed,
which is the normal case during a provider retry storm.

## What events actually do

Adapters classify into a small closed set rather than passing through provider vocabulary,
for the same reason retry policy branches on normalized error codes (plan §79):

| Kind                    | Effect                                            |
| ----------------------- | ------------------------------------------------- |
| `authorization_revoked` | connection health → `revoked`                     |
| `permissions_changed`   | connection health → `permission_missing`          |
| `publish_succeeded`     | reserved for async publish confirmation           |
| `publish_failed`        | reserved for post-acceptance failure              |
| `account_updated`       | recorded only                                     |
| `engagement`            | recorded only, consumed by the engagement layer   |
| `unrecognized`          | recorded only                                     |

Most provider traffic changes nothing. An engagement event says nothing about whether a
credential still works, and downgrading health on one would disable publishing for a
perfectly healthy account.

The health transition is conditional on the current value, and `connection.reauth_required`
is emitted to the customer **only when the transition actually moved something**. That is
what makes an at-least-once webhook safe to receive twice: a redelivered revocation
produces one customer alert, not one per delivery. An alert that fires on every redelivery
is an alert that gets muted.

## Failure handling

| Situation                          | Response | Stored | Processed |
| ---------------------------------- | -------- | ------ | --------- |
| Valid signature, known provider     | 200      | yes    | yes       |
| Invalid signature                   | 200      | yes    | no        |
| Unknown provider / no `verifyWebhook` | 404   | no     | no        |
| Body over 1 MB                      | 200      | no     | no        |
| Our own bug during ingress          | 200      | maybe  | no        |

The last row is deliberate. A 5xx tells the provider to retry, and a bug here would retry
identically — converting one broken deploy into sustained inbound traffic. The event is
lost either way; the difference is whether we also spend the incident absorbing a flood.

## Related

- [ADR-006 — effective-once](../adr/ADR-006-effective-once.md)
- [ADR-007 — token encryption](../adr/ADR-007-token-encryption.md)
- Plan §34, §41, §42, §10.4
