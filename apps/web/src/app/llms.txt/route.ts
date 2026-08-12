import { SITE_URL } from '@/lib/seo';

/**
 * `/llms.txt` (plan Phase 3, Documentation).
 *
 * The emerging convention for telling a language model what a site is and where its real
 * documentation lives, in one fetch, without crawling a JavaScript-rendered marketing
 * site and guessing.
 *
 * Worth doing properly here for a reason specific to this product: it is built for
 * autonomous agents (plan P12), and an agent evaluating whether to integrate is exactly
 * the reader this file has. The facts it most needs — that publishing is asynchronous,
 * that preflight is free, that an idempotency key is required — are the ones that produce
 * broken integrations when guessed at.
 *
 * Served as a route rather than a static file so the URLs stay tied to SITE_URL.
 */

const BODY = `# GainingSocial

> One REST API for publishing to every major social network. Built for software and
> autonomous agents: capability discovery before composing, validation without side
> effects, and duplicate prevention that survives timeouts and retries.

## What it does

Publish text, images and video to X, LinkedIn, Facebook Pages, Instagram, Threads, TikTok,
YouTube, Pinterest, Bluesky, Telegram, Discord and Google Business Profile through a single
request. Each destination succeeds or fails independently and is retried independently.

## Facts an integration depends on

- Authentication is \`Authorization: Bearer sk_live_...\` or \`sk_test_...\`. The environment
  is encoded in the key and cannot be chosen per request; a test key can never reach a live
  account.
- \`POST /v1/posts\` returns 202 with status \`queued\` or \`scheduled\`. It never returns
  \`published\`. Publishing happens on a queue. Poll \`GET /v1/posts/{id}\` or subscribe to a
  webhook.
- \`POST /v1/posts\` requires an \`Idempotency-Key\` header. Replaying it with the same body
  returns the original post; replaying with a different body is rejected.
- \`POST /v1/posts/preflight\` takes exactly the same body, performs no side effects, and is
  safe to call as often as you like. Call it before publishing.
- Capabilities are the source of truth for platform limits, not a hard-coded table.
  \`GET /v1/platforms/{provider}/capabilities\` describes the platform;
  \`GET /v1/destinations/{id}/capabilities\` describes one connected account, narrowed by
  granted scopes, account type and platform approval state.
- Errors carry a stable \`code\`, a \`retryable\` boolean and a machine-readable
  \`agent_action\`. Branch on \`code\`, never on \`message\`.
- \`retryable\` is computed from the error taxonomy, not from the HTTP status. Do not infer
  it from the status code.
- \`PROVIDER_TIMEOUT\`, \`POSSIBLE_DUPLICATE\` and \`RECONCILIATION_REQUIRED\` describe an
  outcome that is unknown rather than failed. Do not retry them. The engine reconciles with
  the platform and either adopts the existing post or retries once it has proved nothing was
  created. A client-side retry races that and creates a duplicate.
- All timestamps are UTC ISO-8601. \`retry_after\` is an absolute instant, not a duration.
- Pagination is cursor-based: pass \`next_cursor\` as \`cursor\`. Stop when
  \`has_more\` is false.

## Documentation

- [API documentation](${SITE_URL}/docs): endpoint reference by resource
- [Quickstart](${SITE_URL}/docs/quickstart): nothing to a published post in seven steps
- [Retries and duplicate prevention](${SITE_URL}/docs/retries): why a post is not published twice, and which errors are safe to retry
- [Webhooks](${SITE_URL}/docs/webhooks): signature verification, at-least-once delivery, deduplication
- [Media uploads](${SITE_URL}/docs/media): direct-to-storage uploads, probing, per-platform limits
- [Multi-tenant and white-label](${SITE_URL}/docs/multi-tenant): publishing on behalf of your own customers
- [Supported networks](${SITE_URL}/platforms): what each platform supports and what it requires

## Reference

- OpenAPI specification: ${SITE_URL}/openapi.json
- Error dictionary: ${SITE_URL}/docs/errors

## Notes

- Test and live are separate environments with separate ids. There is no dry-run flag.
- A connection can exist and still not publish: when an account exposes several
  destinations, one must be chosen explicitly. Publishing before then returns
  \`CONNECTION_INCOMPLETE_SETUP\` rather than guessing.
- TikTok and YouTube restrict unaudited applications to private posting. This is reported
  through capabilities as a \`provider_approval_pending\` restriction before publishing, not
  discovered afterwards.
`;

export function GET(): Response {
  return new Response(BODY, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // Static content; a day of caching at the edge is plenty and keeps it cheap to fetch.
      'cache-control': 'public, max-age=3600, s-maxage=86400',
    },
  });
}
