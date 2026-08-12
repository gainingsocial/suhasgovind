# Operations — what needs a human with account access

Everything in this repository builds, tests and deploys from code. This page lists the
things that cannot: they need somebody signed in to Cloudflare, Supabase or a platform's
developer console.

Nothing here blocks the code from being correct. Each item blocks one capability from being
*usable*, and each says which.

---

## 1. Cloudflare queues for the new workers

**Blocks:** inbound provider webhooks being processed.

The provider-webhooks worker produces to a queue that does not exist yet. Create it and its
dead-letter queue once:

```bash
npx wrangler queues create gs-provider-events
npx wrangler queues create gs-provider-events-dlq
```

Without them, `wrangler deploy` for that worker fails with an unknown-queue error. The
existing `gs-publish` and `gs-webhook-delivery` queues are already provisioned.

**How to know it worked:** `npx wrangler queues list` shows all four.

---

## 2. Secrets for the two new workers

**Blocks:** token refresh, and inbound webhook signature verification.

Both workers need the same secrets the publisher already has. Wrangler secrets are per
worker, so they must be set again for each:

```bash
# gs-connection-health — decrypts credentials to refresh them
npx wrangler secret put CREDENTIAL_KEK_V1 --name gs-connection-health
npx wrangler secret put CREDENTIAL_KEK_ACTIVE_VERSION --name gs-connection-health

# gs-provider-webhooks — decrypts the app secret each provider signs with,
# and derives the subscription verify tokens
npx wrangler secret put CREDENTIAL_KEK_V1 --name gs-provider-webhooks
npx wrangler secret put CREDENTIAL_KEK_ACTIVE_VERSION --name gs-provider-webhooks
npx wrangler secret put WEBHOOK_SIGNING_ROOT --name gs-provider-webhooks
```

Use the **same values** already set on `gs-api` and `gs-publisher`. A different KEK on one
worker means credentials encrypted elsewhere cannot be decrypted there, and the symptom is a
refresh that fails for every connection with no obvious cause.

`node scripts/generate-secrets.mjs` prints fresh values — use it only for a new environment,
never to rotate one worker in isolation.

---

## 3. A route for the webhook ingress

**Blocks:** providers being able to reach us at all.

`gs-provider-webhooks` is configured with `workers_dev: false`, so it needs a route on the
real domain. A platform's developer console will not accept a `workers.dev` URL for a
production integration, and changing the URL later means re-registering with every platform.

```
api.gainingsocial.com/webhooks/providers/*  →  gs-provider-webhooks
```

**How to know it worked:** `GET https://api.gainingsocial.com/webhooks/providers/facebook`
returns 404 rather than a Cloudflare error page. (404 is correct for a GET without the
handshake parameters — it proves the worker is reachable.)

---

## 4. Meta webhook subscriptions

**Blocks:** knowing when somebody revokes access, without waiting for a publish to fail.

Only the Meta family has a certified webhook integration. For each of Facebook, Instagram
and Threads, in the Meta app dashboard:

1. Open **Platforms** in our dashboard and copy the **webhook URL** and **verify token**
   shown for that provider. Both are displayed only for providers whose verification is
   implemented, so if a provider shows none, there is nothing to register.
2. In the Meta console, add a webhook with that callback URL and verify token.
3. Subscribe to the fields you want — `feed` and `comments` for a Page, `comments` and
   `mentions` for Instagram.

Meta calls the URL immediately with a `hub.challenge`; if the token matches, it saves.

**How to know it worked:** the Meta console shows the subscription as active, and a test
comment appears under `GET /v1/comments`.

---

## 5. A model provider for Content Intelligence

**Blocks:** source-to-social repurposing. Nothing else.

The model gateway is a port with no adapter. Publishing, composing, media auto-fit,
analytics, the inbox and MCP all work without it (plan P19: AI is optional around
publishing). Until a provider is configured, the content pipeline returns `NOT_CONFIGURED`
rather than producing empty drafts.

To enable it, decide which provider and supply an API key. The gateway interface is
`packages/domain/src/content/model-gateway.ts`; an adapter implements `complete()` and
nothing above it changes.

**This is a decision, not just a key** — model choice affects cost per source and output
quality, and I did not want to pick one on your behalf.

---

## 6. Platform credentials

**Blocks:** each platform individually.

Unchanged from before, and tracked in [`PLATFORM_APPROVALS.md`](../PLATFORM_APPROVALS.md).
Paste a client id and secret on the **Platforms** page and that provider goes live — no
deploy. Bluesky, Telegram and Discord need nothing.

---

## Database migrations

Applied automatically? **No.** Run them yourself after a deploy that includes one:

```bash
pnpm db:migrate
```

The pooled `DATABASE_URL` connects as `gs_app`, which deliberately has no DDL permission —
an application role that can drop tables is one an application bug can drop tables with. The
runner falls back to the Supabase Management API, which needs `SUPABASE_ACCESS_TOKEN` in
`.env`.

If the Management API returns a 5xx, it is a Supabase-side outage and the correct response
is to retry rather than to grant `gs_app` more permission.

Migrations `0005` through `0010` are already applied to the current database.
