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
| Business email on the company domain | ☐ not started | `@gainingsocial.com`, not Gmail |
| Public marketing site | ☑ built | `gainingsocial.com` — pages live, zone active in Cloudflare |
| Privacy policy | ☑ built | `/privacy` — required by Meta, LinkedIn, TikTok, Google |
| Terms of service | ☑ built | `/terms` |
| Data deletion instructions + callback | ☐ not started | `/data-deletion` — Meta hard requirement |
| Demo screencast of the publish flow | ☐ blocked on credentials | Reused across Meta, TikTok, LinkedIn Standard Tier. The flow it records is now buildable end to end — connect, compose, publish, watch the timeline — but a recording needs a real account on the platform being reviewed, which needs that platform's credentials first. Bluesky or Telegram can be recorded today |
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

### TikTok

Content Posting API requires an audit **separate from** developer signup. Until it passes,
every direct post is forced to `SELF_ONLY` (visible to the creator alone).

| Field | Value |
| --- | --- |
| Status | ☐ not started |
| Portal | https://developers.tiktok.com |
| Product | Content Posting API |
| Scopes | `video.publish` (direct live post) vs `video.upload` (lands in creator inbox) |
| Audit | 2–4 weeks, multiple feedback rounds typical |
| Audit submission | Recorded demo of full posting flow + privacy policy URL + proof of finished product |
| **Required UI** | Creator username and avatar shown before every post; commercial-content disclosure toggle. Verified during review — not optional |
| Client key / secret | Not yet issued |

### YouTube

| Field | Value |
| --- | --- |
| Status | ☐ not started |
| Portal | Google Cloud Console + YouTube API compliance audit |
| Prerequisite | Google Cloud project, OAuth consent screen, verified domain |
| Restriction | Uploads from unverified API projects are restricted to private until audit passes |
| Scopes | `youtube.upload`, `youtube.readonly` |

### Remaining

| Provider | Status | Notes |
| --- | --- | --- |
| Pinterest | ☐ not started | Standard app review |
| X | ☐ not started | Paid API tier; confirm current write-access pricing before committing |
| Discord | ☐ not started | Bot token + OAuth2; lightest review of the set |
| Google Business Profile | ☐ not started | Requires GCP project + separate API access request |
| Reddit | ☐ evaluate first | Plan §62.2 — assess current commercial/developer terms before committing engineering time |

---

## Per-provider certification gate

No adapter ships until it passes the Platform Adapter Certification Checklist (plan §65):
authentication, destinations, publishing, validation, reliability, webhooks, documentation,
tests. An approval grants access; it does not certify the adapter.
