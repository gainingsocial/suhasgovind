# Error codes

Every error response carries the same envelope. Branch on `code`, never on `message` —
codes are stable and versioned, messages are not.

```json
{
  "error": {
    "type": "authentication_error",
    "code": "API_KEY_REVOKED",
    "message": "This API key has been revoked.",
    "retryable": false,
    "docs_url": "https://gainingsocial.com/docs/errors/API_KEY_REVOKED",
    "request_id": "req_06fy2aavb5yb1db0enh4wc7yj4",
    "trace_id": "trc_06fy2aavb5yb3351nf1fbt8aag"
  }
}
```

`request_id` and `trace_id` are always present, on every response including successes
(as the `x-request-id` and `x-trace-id` headers). Quote either one in a support request.

The catalog lives in `packages/errors/src/catalog.ts` and is the single source of truth —
the OpenAPI document generates its per-route error lists from it, so this page and the
published contract cannot disagree about what a route can return. A code that exists in the
catalog and not on this page fails the build.

## Reading `retryable`

`retryable` is computed from the catalog, not from the status code, and the two disagree
often enough that guessing from the status is a real source of bugs. Two 409s make the
point: `IDEMPOTENCY_REQUEST_IN_PROGRESS` is retryable, because the first request is still
running and will finish; `DUPLICATE_CONTENT_BLOCKED` is not, because retrying identical
content can only be refused identically.

`retryable: false` never means "give up". It means *this exact request* will fail the same
way — change something, or take the `agent_action`.

Three codes deserve particular care because they describe an outcome that is genuinely
unknown rather than failed:

| Code | Why it is not a failure |
| --- | --- |
| `PROVIDER_TIMEOUT` | The provider may have published before the connection dropped. |
| `POSSIBLE_DUPLICATE` | The provider says equivalent content may already exist. |
| `RECONCILIATION_REQUIRED` | We are already asking the provider what happened. |

None of them should be retried by a caller. The engine reconciles first and either adopts
the post it finds or retries once it has proved nothing was created (ADR-006 Layer 4). A
client that retries on its own is racing that process, and the prize for winning is a
duplicate post.

## `agent_action`

Most codes carry a machine-readable `agent_action` — `shorten_text`, `attach_media`,
`create_connect_session_for_reauthorization`. It exists so an autonomous caller can act
without parsing prose (plan §16, §51). The strings are stable and enumerated in the
catalog.

---

## Authentication

Returned by every route except `/health`.

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `AUTHENTICATION_REQUIRED` | 401 | No `Authorization: Bearer …` header. | Send the key. Only the `Bearer` scheme is accepted. |
| `API_KEY_MALFORMED` | 401 | Not shaped like a key at all. | Check for a truncated or wrapped value. Keys are `sk_live_…` / `sk_test_…`. |
| `API_KEY_INVALID` | 401 | No key matches. | The key was mistyped, deleted, or belongs to another account. |
| `API_KEY_REVOKED` | 401 | Deliberately revoked. | Issue a new key. Revocation is permanent. |
| `API_KEY_EXPIRED` | 401 | Past its `expires_at`. | Issue a new key. |

`API_KEY_INVALID` is returned both for a key that does not exist and for one whose hash
does not verify. The two are deliberately indistinguishable — separating them would
confirm which keys exist.

A key that is both revoked and expired reports `API_KEY_REVOKED`, because that is the
fact that needs a human decision.

## Authorization

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `INSUFFICIENT_SCOPE` | 403 | The key lacks a scope the route requires. | The message names the missing scopes. Grant them and retry. |
| `TENANT_FORBIDDEN` | 403 | The resource belongs to another tenant. | Usually a test key used against live data, or an id from another project. |
| `ENVIRONMENT_MISMATCH` | 403 | The resource belongs to a different environment than the key. | A `sk_test_` key cannot touch live data, or the reverse. Use the matching key. |

Scopes do not imply one another. `posts:write` does not grant `posts:read` — creating a
post and enumerating existing ones are different capabilities, so each route declares
exactly what it needs.

`TENANT_FORBIDDEN` is returned rather than a 404. Both leak the same single bit (that the
id exists), and a distinct code lets a genuine cross-project mistake be understood instead
of sending someone hunting a phantom 404.

`ENVIRONMENT_MISMATCH` is the one people hit in their first hour. Test and live are
separate worlds with separate ids (plan §6); an id copied from the live dashboard into a
test script does not resolve.

## Request shape

Returned before any business logic runs.

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `INVALID_REQUEST` | 400 | The body failed schema validation. | `details[]` names each failing path. |
| `MISSING_REQUIRED_FIELD` | 400 | A required field is absent. | `param` names it. |
| `UNSUPPORTED_CONTENT_TYPE` | 415 | Not `application/json`. | Send `Content-Type: application/json`. |
| `REQUEST_TOO_LARGE` | 413 | The body exceeds the limit. | Upload media through `/v1/media/uploads`, never inline. |
| `UNSUPPORTED_API_VERSION` | 400 | Unknown version requested. | Omit the version header to get the current one. |
| `PROVIDER_NOT_SUPPORTED` | 400 | Unknown provider name. | `GET /v1/platforms` lists every valid value. |

`INVALID_REQUEST` always carries `details[]` with a `path` per failure, so a form can mark
the offending fields rather than showing one message at the top.

## Not found

| Code | Status | Meaning |
| --- | --- | --- |
| `PROFILE_NOT_FOUND` | 404 | No such profile. |
| `CONNECTION_NOT_FOUND` | 404 | No such connection. |
| `DESTINATION_NOT_FOUND` | 404 | No such destination. |
| `MEDIA_NOT_FOUND` | 404 | No such media asset. |
| `POST_NOT_FOUND` | 404 | No such post. |
| `TARGET_NOT_FOUND` | 404 | No such publish target. |
| `WEBHOOK_NOT_FOUND` | 404 | No such webhook endpoint. |
| `DELIVERY_NOT_FOUND` | 404 | No such webhook delivery. |
| `RESOURCE_NOT_FOUND` | 404 | Generic fallback. |

These are per-resource rather than one generic code so a caller can tell *which* id in a
multi-id request was wrong — a post create naming a bad profile and a bad destination
should not report the same thing twice.

A 404 here means "not visible to this key". An id belonging to another project reports
`TENANT_FORBIDDEN` instead; see the note above on why.

## Governance

Returned by the approval control plane (plan Phase 9).

| Code | Status | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `APPROVAL_ALREADY_DECIDED` | 409 | no | Somebody already approved or rejected this request. | Read the current decision. This is not a race you lost — it is a race somebody won. |

Two approvers acting at once is the normal case, not an edge case: the notification goes to
a team. The first decision wins and the second is refused, because the alternative is a
rejection landing on top of an approval that has already released the post.

## Idempotency

`POST /v1/posts` requires an `Idempotency-Key`. It is not optional, because a duplicate
published post cannot be undone (plan §25 Layer 1).

| Code | Status | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | no | No `Idempotency-Key` header. | Send one. Any unique string; a UUID is ideal. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | no | The key was used with a *different* body. | Use a new key. Reusing one for different content is the bug this catches. |
| `IDEMPOTENCY_REQUEST_IN_PROGRESS` | 409 | **yes** | An identical request is still running. | Wait and retry the identical request. Do not change the key. |

Replaying a key with the *same* body is not an error — it returns the original response.
That is the entire point: a network timeout on your side can be retried safely.

The SDK generates a key automatically and reuses it across its own retries. Supply your own
when your job has a stable identity, so that a retry of *your job* is also deduplicated.

## Conflicting state

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `DUPLICATE_CONTENT_BLOCKED` | 409 | Equivalent content went to this destination recently. | Change the content, or set `allow_duplicate: true` deliberately. |
| `POST_NOT_CANCELLABLE` | 409 | Publishing has begun or finished. | Nothing to cancel. Delete the published post instead, where the platform allows it. |
| `POST_NOT_RETRYABLE` | 409 | No target is in a retryable state. | Check `GET /v1/posts/{id}/timeline` for what actually happened. |
| `TARGET_NOT_RETRYABLE` | 409 | This target is not in a retryable state. | A target that published cannot be retried; that would duplicate it. |
| `CONFLICTING_STATE` | 409 | The resource changed mid-request. | Re-read and retry. |
| `RESOURCE_ALREADY_EXISTS` | 409 | That identifier is taken. | Fetch the existing resource or choose another identifier. |

`DUPLICATE_CONTENT_BLOCKED` is a guard, not a platform rule (plan §25 Layer 2). It catches
the overwhelmingly common accident — a scheduler firing twice — while leaving the
deliberate case available through `allow_duplicate`.

## Connection state

A connection can exist and still be unable to publish.

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `CONNECTION_REAUTH_REQUIRED` | 409 | The credential expired and cannot be refreshed. | Create a connect session and have the account holder re-authorize. |
| `CONNECTION_DISCONNECTED` | 409 | Disconnected on our side. | Reconnect. |
| `CONNECTION_REVOKED` | 409 | The user revoked access at the provider. | Reconnect. Nothing on our side can restore it. |
| `CONNECTION_PERMISSION_MISSING` | 409 | A required scope was never granted. | Re-authorize requesting the scopes the message names. |
| `CONNECTION_INCOMPLETE_SETUP` | 409 | More than one destination is available and none was chosen. | Call `/v1/connections/{id}/destinations/select`. |
| `CONNECTION_RATE_LIMITED` | 429 | The provider is rate limiting this specific account. | Honour `retry_after`. This is per-account, not per-project. |

`CONNECTION_INCOMPLETE_SETUP` exists because guessing is worse than asking. An account with
four Facebook Pages has no obvious default, and publishing to the wrong one is not
recoverable by deleting the post.

## Connecting an account

Returned by `/v1/connections/authorize`, `/v1/connections/complete`, the provider callback
and the hosted connect flow.

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `PROVIDER_NOT_CONFIGURED` | 503 | The adapter exists but no platform application credentials are configured for it. | Nothing on your side. The platform is awaiting its client id and secret; `GET /v1/platforms` shows what is connectable now. |
| `PROVIDER_TEMPORARILY_DISABLED` | 503 | We have deliberately switched this platform, or one of its features, off. | Nothing on your side, and the request was correct. Retry later, or publish to another destination. A queued post is retried automatically rather than failed. |
| `AUTHORIZATION_SESSION_INVALID` | 400 | The `state` is unknown, already used, or expired. | Start again at `/v1/connections/authorize`. States are single-use and expire in 15 minutes. |
| `AUTHORIZATION_FAILED` | 400 | The provider declined, the user cancelled, or the account authorized nothing publishable. | The `error_detail` on the callback redirect carries the provider's own reason. |
| `AUTHORIZATION_CREDENTIAL_REJECTED` | 400 | The provider rejected the supplied credential. | Almost always a mistyped app password or bot token. Nothing is stored when this happens. |
| `REDIRECT_URL_NOT_ALLOWED` | 400 | `redirect_url` is not absolute HTTPS, or embeds credentials. | Use an absolute `https://` URL. Plain HTTP is permitted only for `localhost`. |
| `CONNECT_SESSION_INVALID` | 400 | The hosted connect link is expired, completed, or its signature does not verify. | Create a new session. Links are bearer credentials and are deliberately short-lived. |

Three different 503s mean three different things, and the distinction is what tells you
whether to wait, to check the status page, or to do nothing at all.
`PROVIDER_NOT_CONFIGURED` means the platform has never been switched on here.
`PROVIDER_TEMPORARILY_DISABLED` means it normally works and we have turned it off on
purpose — usually because the platform is misbehaving and we would rather queue your posts
than burn them against a broken API. `PROVIDER_UNAVAILABLE` means the platform itself is
failing right now.

`AUTHORIZATION_SESSION_INVALID` covers three distinct situations on purpose — unknown,
already-consumed and expired. The callback is an unauthenticated endpoint, and confirming
that a state *existed* tells whoever replayed it that they hold a real handshake.

A connection can exist and still not publish. `setup_complete: false` means the account
authorized more than one destination and one has yet to be chosen; publishing to it before
then fails with `CONNECTION_INCOMPLETE_SETUP` rather than guessing which Page was meant.

## Composing a post

Everything here is returned by `POST /v1/posts/preflight` as well as by `POST /v1/posts`.
Preflight has no side effects and is free to call — running it first is how these stop
being errors at all (plan §18).

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `VALIDATION_FAILED` | 422 | One or more targets cannot publish as composed. | `details[]` carries a per-target breakdown. Call preflight for the full picture. |
| `TARGETS_REQUIRED` | 422 | No targets given. | A post needs at least one destination. |
| `DUPLICATE_DESTINATION` | 422 | The same destination appears twice in `targets`. | Deduplicate. Two targets to one destination would be two posts. |
| `CAPABILITY_NOT_SUPPORTED` | 422 | The destination cannot do this at all. | Check `GET /v1/destinations/{id}/capabilities`. |
| `POST_TYPE_NOT_SUPPORTED` | 422 | This post type is unavailable here. | Choose a supported type. |
| `TEXT_TOO_LONG` | 422 | Over the destination's limit. | Shorten, or set a per-target override. |
| `TEXT_REQUIRED` | 422 | This destination will not take an empty post. | Supply text. |
| `MEDIA_REQUIRED` | 422 | This destination requires media. | TikTok, Pinterest and YouTube have no text-only post. |
| `MEDIA_COUNT_EXCEEDED` | 422 | Too many media items. | Reduce the count, or split into several posts. |
| `MEDIA_MIXED_TYPES_UNSUPPORTED` | 422 | Images and video in one post. | Most platforms take one or the other. Split them. |
| `LINK_NOT_SUPPORTED` | 422 | No link attachment here. | Remove `link_url`, or put the URL in the text. |
| `PROVIDER_OPTION_INVALID` | 422 | A provider-specific option is wrong. | `param` names it. |
| `PROVIDER_OPTION_REQUIRED` | 422 | A provider-specific option is mandatory here. | The message names it. |
| `PRIVACY_SELECTION_REQUIRED` | 422 | This destination demands an explicit privacy level. | TikTok has no default and rejects a post without one. |
| `COMPLIANCE_DECLARATION_REQUIRED` | 422 | A declaration is required before publishing. | YouTube requires a made-for-kids declaration on every upload. |

`VALIDATION_FAILED` is the aggregate; the specific codes appear inside `details[]` with the
`destination_id` and `provider` that produced each one. A post to five platforms that fails
on one reports which.

## Scheduling

| Code | Status | Meaning |
| --- | --- | --- |
| `SCHEDULE_IN_PAST` | 422 | `publish_at` is not in the future. |
| `SCHEDULE_TOO_FAR_AHEAD` | 422 | Beyond the maximum scheduling horizon. |
| `SCHEDULE_NOT_SUPPORTED` | 422 | This destination cannot schedule. |

All timestamps are UTC ISO-8601 (Rule 15). A `publish_at` without a timezone is rejected
rather than assumed to be UTC — the assumption is wrong often enough, and by whole hours.

## Media

| Code | Status | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `MEDIA_TYPE_UNSUPPORTED` | 422 | no | Wrong format for this destination. | Supply a variant in an accepted type. |
| `MEDIA_TOO_LARGE` | 422 | no | Over the size limit. | Re-encode smaller. |
| `MEDIA_RATIO_UNSUPPORTED` | 422 | no | Aspect ratio not accepted. | Crop to a supported ratio. |
| `MEDIA_RESOLUTION_UNSUPPORTED` | 422 | no | Dimensions out of range. | Resize. |
| `MEDIA_DURATION_UNSUPPORTED` | 422 | no | Video too long or too short. | Trim or extend. |
| `MEDIA_NOT_READY` | 409 | **yes** | Still being probed or processed. | Wait for the `media.ready` webhook. |
| `MEDIA_UPLOAD_INCOMPLETE` | 409 | no | The bytes went up but completion was never called. | Call `/v1/media/uploads/{id}/complete`. |
| `MEDIA_PROBE_FAILED` | 422 | no | The file could not be read. | Corrupt, or an unsupported container. |
| `MEDIA_PROCESSING_FAILED` | 422 | no | Processing failed. | Try a different file. |
| `MEDIA_URL_NOT_ALLOWED` | 422 | no | The external URL is not permitted. | Must be public HTTPS and must not resolve to a private network. |

`MEDIA_URL_NOT_ALLOWED` is an SSRF guard (plan §68). A URL resolving to `169.254.169.254`,
`10.0.0.0/8` or `localhost` is refused regardless of what it hosts, and redirects are
re-checked at every hop.

`MEDIA_NOT_READY` is the one media code worth retrying. Everything else is a property of
the file that another attempt cannot change.

## Rate limits and quotas

| Code | Status | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `RATE_LIMITED` | 429 | yes | Too many requests to this API. | Honour `retry_after`. |
| `CONNECTION_RATE_LIMITED` | 429 | yes | The *provider* is limiting this account. | Honour `retry_after`. Slowing your calls to us does not help. |
| `QUOTA_EXCEEDED` | 429 | yes | A provider quota is exhausted for the period. | Wait for the reset. YouTube's daily upload allowance is the common case. |
| `PLAN_LIMIT_REACHED` | 402 | no | Your plan's limit. | Upgrade, or wait for the period to roll over. |

`retry_after` is a UTC ISO-8601 instant, not a duration — no arithmetic, no ambiguity about
when the clock started. It is present whenever the provider told us when to come back.

## Provider failures

Returned when a platform itself failed, after the post was accepted.

| Code | Status | Retryable | Meaning |
| --- | --- | --- | --- |
| `PROVIDER_UNAVAILABLE` | 503 | yes | The platform is down or unreachable. |
| `PROVIDER_TIMEOUT` | 504 | **no** | No response in time. The outcome is unknown. |
| `PROVIDER_REJECTED_CONTENT` | 422 | no | The platform refused the content. |
| `PROVIDER_CONFLICT` | 409 | no | The platform reported a conflicting state. |
| `PROVIDER_ACCOUNT_NOT_ELIGIBLE` | 422 | no | The account cannot do this — wrong type, or missing an entitlement. |
| `POSSIBLE_DUPLICATE` | 409 | **no** | The platform says equivalent content may already exist. |
| `RECONCILIATION_REQUIRED` | 409 | **no** | The previous attempt's outcome is unknown and is being reconciled. |
| `UNKNOWN_PROVIDER_ERROR` | 502 | **no** | The platform's error could not be classified. |

The four marked in bold are not retryable *on purpose*, and it is worth understanding why
before working around it. Each describes a situation where the post may already exist. The
engine resolves them by asking the platform directly and either adopting what it finds or
retrying once it has proved nothing was created. Retrying from the client short-circuits
that and produces the duplicate the whole design exists to prevent (plan §2.2, ADR-006).

`PROVIDER_ACCOUNT_NOT_ELIGIBLE` most often means a personal Instagram account where a
Business or Creator account is required — the connection succeeds and publishing does not.

## Content Intelligence

| Code | Status | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `MODEL_PROVIDER_NOT_CONFIGURED` | 503 | no | No model provider is configured. | Nothing you can do from the API; the platform operator supplies the key. |
| `CONTENT_GROUNDING_FAILED` | 422 | no | A generated claim could not be traced to the source it cites. | Edit the draft so every claim is grounded, then publish. |
| `SOURCE_NOT_FOUND` | 404 | no | No such content source or source item within your tenant. | Check the id and the environment the key is scoped to. |
| `DRAFT_SET_NOT_FOUND` | 404 | no | No such draft set within your tenant. | Check the id and the environment. |

`MODEL_PROVIDER_NOT_CONFIGURED` is scoped to the content pipeline and nothing else.
Publishing, composing, media auto-fit, analytics, the inbox and MCP all work without a
model (P19), so this never degrades the parts of the product that matter most.

`CONTENT_GROUNDING_FAILED` is not overridable, including by a source whose automation mode
is `auto_publish_if_safe`. Choosing that mode expresses a preference about review; it does
not assert that a specific claim was checkable. A set that fails grounding may be edited and
re-verified, but not published as it stands (P18).

## Server

| Code | Status | Retryable | Meaning | What to do |
| --- | --- | --- | --- | --- |
| `INTERNAL_ERROR` | 500 | yes | Unexpected fault, or the platform is misconfigured. | Retry once; if it persists, quote `request_id`. |
| `NOT_IMPLEMENTED` | 501 | no | The operation is not built yet. | It is on the roadmap; the message says so. |
| `FEATURE_DISABLED` | 403 | no | Not enabled for your project. | Contact support. |
| `SIMULATION_ONLY` | 403 | no | Available only in the simulation environment. | Use a live key. |

An unexpected throw is never surfaced verbatim — its message and stack stay in the logs,
because that is where credentials and internal hostnames leak from.
