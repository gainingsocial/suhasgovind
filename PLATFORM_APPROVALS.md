# Platform Approvals

Plan §63 requires this file. Provider application and audit timelines are **on the critical
path** — TikTok restricts unaudited clients to private-only posting, YouTube restricts uploads
from unverified API projects to private, and LinkedIn gates its publishing APIs behind a
two-tier commercial review. None of that can be compressed by writing code faster, so the
applications run as a parallel workstream from Day 1.

Adapter code does **not** wait on approval. Every adapter is built against the official
documented behaviour (Rule 2) with credentials resolved from `provider_apps` at runtime
(plan §23), so a granted client ID/secret is a database row, never a code change.

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
| Public marketing site | ☐ not started | `gainingsocial.com` — zone active in Cloudflare |
| Privacy policy | ☐ not started | `/privacy` — required by Meta, LinkedIn, TikTok, Google |
| Terms of service | ☐ not started | `/terms` |
| Data deletion instructions + callback | ☐ not started | `/data-deletion` — Meta hard requirement |
| Demo screencast of the publish flow | ☐ not started | Reused across Meta, TikTok, LinkedIn Standard Tier |
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

One app covers all three. Business Verification is the long pole and gates Advanced Access.

| Field | Value |
| --- | --- |
| Status | ☐ not started |
| Portal | https://developers.facebook.com |
| App type | Business |
| Products | Facebook Login for Business, Instagram Graph API, Threads API |
| Business Verification | ☐ not started — start immediately, independent of app review |
| App review | Requires screencast; budget 4–6 weeks |
| Test assets | Instagram **Business or Creator** account linked to a Facebook Page |
| App ID / secret | Not yet issued |
| Reviewer feedback | — |

Permissions requiring Advanced Access:
`pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, `instagram_basic`,
`instagram_content_publish`, `business_management`, `threads_basic`, `threads_content_publish`

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
