# Operations — what needs a human with account access

Everything in this repository builds, tests and deploys from code. This page lists the
things that cannot: they need somebody signed in to Cloudflare, Supabase or a platform's
developer console.

Nothing here blocks the code from being correct. Each item blocks one capability from being
*usable*, and each says which.

---

## 1. Cloudflare queues — done, no action needed

All six queues exist: `gs-publish`, `gs-webhook-delivery` and `gs-provider-events`, each with
its dead-letter pair. The provider-events pair was created 2026-08-12.

Verified 2026-08-14 with `npx wrangler queues list`. Nothing to do.

A queue cannot be missing silently, which is why this needs no ongoing check: a Worker
declaring a consumer for a queue that does not exist fails `wrangler deploy` outright, so a
green deploy is itself the proof.

---

## 2. Worker secrets — done, no action needed

Wrangler secrets are per worker, and every worker that needs one has it. Verified
2026-08-14 with `npx wrangler secret list --name <worker>`:

| Worker | Secrets set |
| --- | --- |
| `gs-api` | `CREDENTIAL_KEK_V1`, `CREDENTIAL_KEK_ACTIVE_VERSION`, `API_KEY_HASH_PEPPER`, `WEBHOOK_SIGNING_ROOT`, `CONNECT_SESSION_SIGNING_KEY`, the four `R2_*` |
| `gs-publisher` | `CREDENTIAL_KEK_V1`, `CREDENTIAL_KEK_ACTIVE_VERSION`, the four `R2_*` |
| `gs-connection-health` | `CREDENTIAL_KEK_V1`, `CREDENTIAL_KEK_ACTIVE_VERSION` |
| `gs-provider-webhooks` | `CREDENTIAL_KEK_V1`, `CREDENTIAL_KEK_ACTIVE_VERSION`, `WEBHOOK_SIGNING_ROOT` |
| `gs-customer-webhooks` | `WEBHOOK_SIGNING_ROOT` |
| `gs-reconciler` | none needed — it never decrypts a credential |

The KEK must be the **same value** on every worker that holds it. A worker with a different
KEK cannot decrypt credentials encrypted elsewhere, and the symptom is a refresh that fails
for every connection with no obvious cause.

`node scripts/generate-secrets.mjs` prints fresh values — use it only for a new environment,
never to rotate one worker in isolation.

---

## 3. The webhook hostname — done, no action needed

The ingress lives at **`webhooks.gainingsocial.com`**, not under the API.

`api.gainingsocial.com` is a Cloudflare *Custom Domain* bound to `gs-api`, and a Custom
Domain claims the entire hostname — a second Worker cannot be routed to a subpath of it.
That constraint pushes toward the better arrangement anyway: ingress is the one path with a
hard acknowledgment deadline, so keeping it off the API's isolate means webhook traffic and
API traffic cannot contend.

The hostname is declared as a Custom Domain in the worker's own config, so `wrangler deploy`
creates it and its DNS record. Nothing to do by hand.

**How to know it worked:** `GET https://webhooks.gainingsocial.com/webhooks/providers/facebook`
returns **403 with an empty body**. That is the pass, not a failure.

A plain GET carries no `hub.mode`/`hub.challenge`, so the Meta adapter reads it as a failed
subscription handshake and refuses it — the same answer anyone gets who finds the URL without
knowing the verify token. Reaching that refusal at all means the request was routed to the
ingress Worker, decoded as a provider path, and handed to a real adapter.

What the other answers mean:

| Response | Meaning |
| --- | --- |
| `403`, empty body | Correct. Ingress is live and the Meta adapter is wired up |
| `404`, empty body | Ingress is live, but that provider has no certified webhook verification. Correct for every provider outside the Meta family |
| A JSON error envelope | Wrong Worker — the API is answering this hostname |
| A Cloudflare error page | The Worker is not deployed, or the Custom Domain is missing |

Verified 2026-08-14: returns 403 with `cfWorker` timing present, which is the expected pass.

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

## 7. Outbound email — done, no action needed

**Was blocking:** every sign-up. Nobody outside the Supabase project could receive a
sign-in link, so the dashboard was effectively closed to customers.

Sending runs on **Cloudflare Email Service** (public beta, Workers Paid, ~$0.35 per 1,000).
Set up 2026-08-14 and verified end to end.

| Setting | Value |
| --- | --- |
| Host | `smtp.mx.cloudflare.net` |
| Port | `465`, implicit TLS |
| Username | the literal string `api_token` |
| Password | a Cloudflare API token with **Email Sending: Edit** |
| From | `accounts@gainingsocial.com` |

Port 465 is the only outbound option Cloudflare offers. Plaintext SMTP, STARTTLS on 587 and
unauthenticated relay on 25 are all unsupported, so a client that cannot do implicit TLS
cannot send through this at all.

**The username trips everyone.** The token goes in the *password* field and the username is
the fixed string `api_token`. Cloudflare's own documentation contradicts itself here — the
settings table says one thing and the `535 5.7.8` troubleshooting note says the opposite —
so it was settled against the live server: `api_token` authenticates, and the token as
username hangs until it times out.

DNS was added automatically because the zone is on Cloudflare. All five records resolve:
`cf-bounce` MX ×3, the SPF TXT on `cf-bounce`, and DKIM on
`cf-bounce._domainkey.gainingsocial.com`. Sent mail aligns for DMARC through DKIM, since the
Return-Path sits on the `cf-bounce` subdomain rather than the apex.

Re-run after any change with `node scripts/setup-auth-email.mjs`. It is idempotent.

**How to know it worked:** request a sign-in link and receive it. The Supabase auth endpoint
returns 200 once it has handed the message to SMTP and 500 when the handoff fails, so a 200
plus an arriving email is the full check.

### Two things to decide

**DMARC is now `p=reject` with no reporting address.** Cloudflare set
`_dmarc.gainingsocial.com` to `v=DMARC1; p=reject;` during onboarding. That is the strictest
policy: any mail claiming to be from this domain that fails both SPF and DKIM alignment is
refused outright rather than sent to spam. Mail we send through Cloudflare is fine. Anything
*else* that ever sends as `@gainingsocial.com` — a marketing tool, a helpdesk, Google
Workspace — will be rejected until its SPF or DKIM is added. There is also no `rua=`, so
none of that is reported and the first symptom would be mail silently vanishing. Adding a
reporting address is cheap insurance.

**Inbound mail still goes to Namecheap.** The apex MX records point at
`eforward1-5.registrar-servers.com` and the apex SPF authorizes only their forwarder — this
is untouched, so existing forwarding keeps working. But `accounts@gainingsocial.com` only
receives replies if that address exists in the Namecheap forwarder. Sending does not depend
on it. Moving inbound to Cloudflare Email Routing would replace the apex MX and is a
separate decision.

---

## Database migrations

```bash
pnpm db:migrate            # apply everything pending
pnpm db:migrate --dry-run  # list what would run, change nothing
```

The runner picks its own transport. The pooled `DATABASE_URL` connects as `gs_app`, which
deliberately has no DDL permission — an application role that can drop tables is one an
application bug can drop tables with — so the run probes it, sees the refusal, and falls
through to the Supabase Management API, which acts as `postgres`. It needs
`SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN` in `.env`; both are already set.

The probe is the first DDL statement the migration needs anyway, so a transport that passes
it has done real work rather than merely predicted it. Only a permission failure falls
through: a syntax error in a migration fails identically on every transport, and retrying it
elsewhere would turn one clear error into two confusing ones.

If the Management API returns a 5xx, that is a Supabase-side outage — retry rather than
granting `gs_app` more permission.

Everything through `0011_social_memory` is applied to the current database. New tables get
their `gs_app` grants automatically, because `0002_app_role` set default privileges for
objects `postgres` creates in `public` — there is no grant to remember alongside a
migration.

**Run automatically on deploy — nothing to remember.** The workflow applies pending
migrations before it deploys a single Worker, using the same command and the same fallback.

Schema before code, always. Every migration here is additive, so a database one migration
ahead of the running Workers is harmless, while a Worker ahead of the database returns 500s
on a missing relation. That asymmetry decides the ordering and is what makes automating it
safe: applying first can only leave the old code reading a schema it already understands.

A migration that *removes* something breaks that assumption, and has to be split — deploy
code that no longer uses the column, then drop it in a later migration. The ordering here
quietly enforces that discipline.

Running it locally is still fine and is the fastest way to see what is pending:
`pnpm db:migrate --dry-run`.
