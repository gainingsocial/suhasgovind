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
    "docs_url": "https://docs.gainingsocial.com/errors/API_KEY_REVOKED",
    "request_id": "req_06fy2aavb5yb1db0enh4wc7yj4",
    "trace_id": "trc_06fy2aavb5yb3351nf1fbt8aag"
  }
}
```

`request_id` and `trace_id` are always present, on every response including successes
(as the `x-request-id` and `x-trace-id` headers). Quote either one in a support request.

The catalog lives in `packages/errors/src/catalog.ts` and is the single source of truth —
the OpenAPI document generates its per-route error lists from it, so this page and the
published contract cannot disagree about what a route can return.

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

Scopes do not imply one another. `posts:write` does not grant `posts:read` — creating a
post and enumerating existing ones are different capabilities, so each route declares
exactly what it needs.

`TENANT_FORBIDDEN` is returned rather than a 404. Both leak the same single bit (that the
id exists), and a distinct code lets a genuine cross-project mistake be understood instead
of sending someone hunting a phantom 404.

## Server

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `INTERNAL_ERROR` | 500 | Unexpected fault, or the platform is misconfigured. | Retry once; if it persists, quote `request_id`. |

An unexpected throw is never surfaced verbatim — its message and stack stay in the logs,
because that is where credentials and internal hostnames leak from.
