# Platform Approvals

Plan §63 requires this file. Provider application and audit timelines are **on the critical
path** — TikTok restricts unaudited clients to private-only posting, YouTube restricts uploads
from unverified API projects to private, and LinkedIn gates its publishing APIs behind a
two-tier commercial review. None of that can be compressed by writing code faster, so the
applications run as a parallel workstream from Day 1.

Adapter code does **not** wait on approval. Every adapter is built against the official
documented behaviour (Rule 2) with credentials resolved from `provider_apps` at runtime
(plan §23), so a granted client ID/secret is a database row, never a code change.

**How to switch a platform on once approved.** Sign in to the dashboard, open
**Platforms**, and paste the client id and secret. That page also shows the exact redirect
URI to register in the platform's developer console — copy it from there rather than
retyping it, since reviewers check the string character for character. The equivalent API
call is `POST /v1/provider-apps`. Nothing is deployed and nothing restarts; the next
authorization uses the new credentials.

Until credentials exist, `POST /v1/connections/authorize` for that platform returns
`PROVIDER_NOT_CONFIGURED` — a 503 that says the platform is not yet available rather than
a 400 implying the caller did something wrong.

**Legend** — `not started` · `preparing` · `submitted` · `in review` · `changes requested` ·
`approved` · `rejected`

---

## Shared prerequisites

These block *every* commercial application. Reviewers check that the URLs resolve and that the
product described actually exists.

| Item | Status | Notes |
| --- | --- | --- |
| Legal entity (registered name + address) | ☐ not started | LinkedIn rejects personal-email applicants outright |
| Business email on the company domain | ◐ sending works | Outbound runs on Cloudflare Email Service as `accounts@gainingsocial.com`, with SPF and DKIM passing — see [OPERATIONS §7](./docs/OPERATIONS.md). **Receiving is the open half**: reviewers reply to the address on the application, and inbound still goes to the Namecheap forwarder, where a mailbox for the address you submit has to exist |
| Public marketing site | ☑ built | `gainingsocial.com` — pages live, zone active in Cloudflare |
| Privacy policy | ☑ built | `/privacy` — required by Meta, LinkedIn, TikTok, Google |
| Terms of service | ☑ built | `/terms` |
| Data deletion instructions | ☑ built | `/data-deletion` — the human-readable half |
| Data deletion **callback** | ☐ not built | Meta hard requirement, and a separate thing from the page above. Meta POSTs a `signed_request` and expects JSON carrying a confirmation URL and a tracking code. No such route exists yet, so a Meta submission fails this check even though the page passes |
| Demo screencast of the publish flow | ☐ blocked on credentials | Reused across Meta, TikTok, LinkedIn Standard Tier. The flow it records is now buildable end to end — connect, compose, publish, watch the timeline — but a recording needs a real account on the platform being reviewed, which needs that platform's credentials first. Bluesky, Telegram or Discord can be recorded today |
| Support contact | ☐ not started | |

Domains already owned: `gainingsocial.com`, `gainingsocial.in` (both in Cloudflare).

---

## Phase 1 — reference providers (no approval gate)

| Provider | Status | Credential model | Blocker |
| --- | --- | --- | --- |
| **Bluesky** | ☐ awaiting test account | Per-user app password; **no developer portal, no review queue, no client ID** | Test handle + app password |
| **Telegram** | ☐ not started | Bot token from @BotFather | Bot token |

Bluesky is the reference adapter precisely because it has no approval gate — it proves the
whole publishing spine before any reviewer is involved (plan §62.1).

---

## Phase 2 — commercial launch providers

### LinkedIn

Two-tier review; the slowest item on the board. Development Tier carries a hard 12-month
deadline to upgrade to Standard.

| Field | Value |
| --- | --- |
| Status | ☐ not started |
| Portal | https://www.linkedin.com/developers/apps |
| Prerequisite | A LinkedIn **Company Page** under our control |
| Product to request | Community Management API |
| Tier 1 | Development — rate-limited, for building |
| Tier 2 | Standard — requires screen recording demonstrating each declared use case |
| Eligibility | Registered legal organization, commercial use case, business email |
| Client ID / secret | Not yet issued |
| Redirect URI | `https://api.gainingsocial.com/v1/oauth/linkedin/callback` |
| Reviewer feedback | — |

### Meta — Facebook Pages, Instagram, Threads

Adapters built and certified. Credentials go into `provider_apps`; no deploy is needed to
switch any of these on.

**Two app registrations, not one.** Facebook Pages and Instagram share a single Meta app —
an Instagram professional account is reached through the Facebook Page it is linked to, so
one consent screen produces both. **Threads is registered separately**, on its own host
(`graph.threads.net`) with its own client id and secret. A Threads credential pasted into
the Meta app slot authenticates against nothing, and the resulting error does not say so.

Business Verification is the long pole and gates Advanced Access for all of them. It is
independent of app review — start it first and let the two run in parallel.

| Field | Facebook + Instagram | Threads |
| --- | --- | --- |
| Status | ☐ not started | ☐ not started |
| Portal | https://developers.facebook.com | https://developers.facebook.com |
| App type | Business | Threads app (separate registration) |
| Products | Facebook Login for Business, Instagram Graph API | Threads API |
| Business Verification | ☐ required | ☐ required |
| App review | Screencast required; budget 4–6 weeks | Screencast required |
| App ID / secret | Not yet issued | Not yet issued |
| Redirect URI | `https://api.gainingsocial.com/v1/oauth/facebook/callback`<br>`https://api.gainingsocial.com/v1/oauth/instagram/callback` | `https://api.gainingsocial.com/v1/oauth/threads/callback` |
| Reviewer feedback | — | — |

Permissions requiring Advanced Access:
`pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, `pages_manage_engagement`,
`publish_video`, `instagram_basic`, `instagram_content_publish`, `business_management`,
`threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`

**Test assets to prepare before recording the screencast.** Meta rejects submissions whose
recording does not show each permission actually being used, so these have to exist first:

- A Facebook **Page** on the reviewing account, with the reviewer added as an admin.
- An Instagram account switched to **Business or Creator** — a personal account cannot
  publish through the API at all, and this is the single most common reason a Meta
  integration appears to connect and then has no destinations.
- That Instagram account **linked to the Page** (Page settings → Linked accounts). The link
  is what makes it visible to `/me/accounts`; without it, the connection succeeds and
  returns nothing to post to.
- A Threads profile on the same account, for the separate Threads submission.

**Things the adapters already handle, so they do not need to be discovered during review:**

- The Facebook Login callback returns a token valid for about an hour. It is exchanged for
  a long-lived one before anything is stored.
- Publishing uses the **Page** access token, not the user token that listed the Pages.
- `appsecret_proof` is sent on every Facebook and Instagram call, so the app can be
  configured to require it without anything breaking. Threads does not implement it and is
  deliberately excluded.
- Error 506 (duplicate post) routes to reconciliation rather than being reported as a
  failure — see the note in `packages/providers/meta-core/src/graph.ts`.

---

## Phase 5 — expansion providers

**All six adapters are built and certified.** Every one resolves its credentials from
`provider_apps` at runtime, so each entry below is a portal task, not an engineering task.

### Two adapters gate on an audit that changes *what may be published*

TikTok and YouTube are the two cases plan §63 is about. Neither fails an unaudited post —
both quietly restrict it to private — so both adapters refuse to publish anything but a
private post until the audit is recorded, rather than letting a customer believe a public
post exists that nobody can see.

**Recording an audit.** Set `audited: true` in the `metadata` of that provider's
`provider_apps` row. Until then:

- `capabilities()` reports `allowed_privacy_levels` as private-only, with a
  `provider_approval_pending` restriction explaining why.
- Preflight rejects a public post with `PRIVACY_LEVEL_NOT_PERMITTED`.

Nothing is deployed and nothing restarts.

### TikTok

Content Posting API requires an audit **separate from** developer signup. Until it passes,
every direct post is forced to `SELF_ONLY` (visible to the creator alone).

| Field | Value |
| --- | --- |
| Status | ☐ not started |
| Adapter | ☑ built — `@gs/provider-tiktok` |
| Portal | https://developers.tiktok.com |
| Product | Content Posting API |
| Scopes | `user.info.basic`, `video.publish` (direct live post) vs `video.upload` (lands in creator inbox) |
| Optional scope | `video.list` — Display API. Without it, reconciliation after a timeout can only return *indeterminate*, so an ambiguous publish escalates to a human instead of resolving itself. Worth requesting |
| Audit | 2–4 weeks, multiple feedback rounds typical |
| Audit submission | Recorded demo of full posting flow + privacy policy URL + proof of finished product |
| **Required UI** | Creator username and avatar shown before every post; commercial-content disclosure toggle. Verified during review — not optional |
| Client key / secret | Not yet issued |
| Redirect URI | `https://api.gainingsocial.com/v1/oauth/tiktok/callback` |

**Second blocker, easy to miss.** The adapter hands TikTok a media URL to pull from
(`PULL_FROM_URL`), and TikTok refuses any URL whose host has not been verified as ours.
Register the media host under **URL properties** in the developer portal — by DNS record or
a `tiktok-developers-site-verification` meta tag — or every post fails with
`url_ownership_unverified` before a byte moves. This is independent of the audit and can be
done immediately.

| Item | Status |
| --- | --- |
| Media host verified in TikTok URL properties | ☐ not started |

### YouTube

| Field | Value |
| --- | --- |
| Status | ☐ not started |
| Adapter | ☑ built — `@gs/provider-youtube` |
| Portal | Google Cloud Console + YouTube API compliance audit |
| Prerequisite | Google Cloud project, OAuth consent screen, verified domain |
| Restriction | Uploads from unverified API projects are restricted to private until audit passes |
| Scopes | `youtube.upload` (publish only), `youtube` (also delete, edit, read the channel) |
| Redirect URI | `https://api.gainingsocial.com/v1/oauth/youtube/callback` |

**Request a quota increase at the same time as the audit.** `videos.insert` costs 1,600
units against a default allowance of 10,000 per day — six uploads, across every customer on
the project, before everything returns `quotaExceeded`. The adapter classifies that as
`DAILY_QUOTA_EXCEEDED` and waits for the window rather than retrying, so the failure is
graceful, but six a day is not a product.

| Item | Status |
| --- | --- |
| Quota increase requested | ☐ not started |

### Pinterest

| Field | Value |
| --- | --- |
| Status | ☐ not started |
| Adapter | ☑ built — `@gs/provider-pinterest` |
| Portal | https://developers.pinterest.com |
| App review | Standard trial → standard access review |
| Scopes | `user_accounts:read`, `boards:read`, `pins:read`, `pins:write` |
| Redirect URI | `https://api.gainingsocial.com/v1/oauth/pinterest/callback` |

Destinations here are **boards**, not the account — one connection commonly yields dozens.
A test account needs at least one board before the connect flow shows anything.

### X

| Field | Value |
| --- | --- |
| Status | ☐ not started |
| Adapter | ☑ built — `@gs/provider-x` |
| Portal | https://developer.x.com |
| Access tier | **Paid.** Confirm current write-access pricing before committing — this is a recurring cost, not a review |
| App type | Must be a **confidential** client; the adapter authenticates the token endpoint with HTTP Basic |
| Scopes | `tweet.read`, `tweet.write`, `users.read`, `media.write`, `offline.access` |
| Redirect URI | `https://api.gainingsocial.com/v1/oauth/x/callback` |

Two settings that cause silent failures if missed:

- **`offline.access` must be requested**, or X issues no refresh token and the connection
  dies when the access token expires with no way to recover it.
- **`media.write` is granted separately from `tweet.write`.** A connection can post text and
  fail on images. The adapter reports this through effective capability rather than at
  publish time, but the scope still has to be requested.

### Discord

| Field | Value |
| --- | --- |
| Status | ☐ not started — **nothing blocks this one** |
| Adapter | ☑ built — `@gs/provider-discord` |
| Portal | https://discord.com/developers/applications |
| Review | None. A bot token is the entire onboarding |
| Credential model | Bot token, pasted by the customer — no `provider_apps` row needed |
| Bot permissions | Send Messages, Attach Files, Read Message History, View Channel |

Alongside Bluesky and Telegram, this is a provider that works the day the code lands.
Destinations are the text channels of servers the bot has been invited to, and Discord will
enumerate them — so unlike Telegram, the customer does not have to type in chat ids.

### Google Business Profile

| Field | Value |
| --- | --- |
| Status | ☐ not started |
| Adapter | ☑ built — `@gs/provider-google-business-profile` |
| Portal | Google Cloud Console + Business Profile API access request form |
| Prerequisite | Google Cloud project, OAuth consent screen, verified domain |
| Scopes | `https://www.googleapis.com/auth/business.manage` — one scope, all or nothing |
| Redirect URI | `https://api.gainingsocial.com/v1/oauth/google-business-profile/callback` |

**The access request is the whole blocker.** Google grants Business Profile API access per
project, by application, and until it is approved every call returns `PERMISSION_DENIED` —
including listing accounts, so the connect flow cannot complete either. The adapter's
normalized error says so explicitly rather than reporting a generic permission problem,
because the fix is a form rather than a scope.

### Reddit

| Field | Value |
| --- | --- |
| Status | ☐ evaluate first |
| Adapter | ☐ not built |

Plan §62.2 — assess current commercial/developer terms before committing engineering time.
Deliberately the one provider on the board without an adapter.

---

## Per-provider certification gate

No adapter ships until it passes the Platform Adapter Certification Checklist (plan §65):
authentication, destinations, publishing, validation, reliability, webhooks, documentation,
tests. An approval grants access; it does not certify the adapter.
