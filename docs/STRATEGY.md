# Distribution strategy

**The question this answers:** who is this for first, and what has to be true for them to
use it without reading documentation.

---

## What the market actually looks like

Two categories, and they are not competing with each other.

### Unified publishing APIs — crowded, and priced for a narrow buyer

[Ayrshare](https://www.ayrshare.com) runs $149–$599/month and covers 13–15 platforms;
per-profile pricing means a B2C product with fifty customer accounts pays around
[$770/month](https://social-api.ai/blog/social-media-api-pricing-2026).
[Postiz](https://postiz.com) is open source, 30+ platforms, $29/month hosted or free
self-hosted. Buffer shipped a public API and MCP server in May 2026, free on every plan
including the free tier; Hootsuite announced MCP connectors in June.

The MCP surface is *already table stakes*. Postiz, Upload-Post, Outstand, PostEverywhere,
Buffer and Hootsuite all ship one. Having an MCP endpoint is not a differentiator in 2026 —
**not** having one is a disqualification.

### WordPress auto-posters — huge, and reliably disliked

This is the interesting half, because the complaints are specific and structural rather
than matters of taste:

| Plugin | What people actually say |
| --- | --- |
| **Jetpack Social** | 3.3/5 on WordPress.org, with the 1★ cluster on one thing: *"it will not stay connected to my social media accounts."* 8 networks. Per-account captions and images are paid-only, so the free tier sends one caption everywhere |
| **Blog2Social** | Auto-share on publish is paid; free users click a button per post. Reported 100% failure rate on Facebook profiles, and it does not fire unless somebody opens wp-admin and presses Save |
| **FS Poster** | The most capable — 26 networks — but no free tier and no WordPress.org listing, so it is never the default anyone tries first |

Sources:
[best auto-post plugins](https://themegrill.com/blog/social-media-auto-post-wordpress-plugins/),
[Jetpack Social review](https://www.fs-poster.com/blog/jetpack-social-review),
[Blog2Social review](https://www.fs-poster.com/blog/blog2social-review).

Read the complaints together and they are all one complaint: **the share silently did not
happen.** A token expired, a connection dropped, a hook did not fire, and nobody found out
until they went looking.

---

## Where we already win, without building anything

These are not roadmap items. They exist, and they answer the top three complaints directly.

**Connections that stop working are the product's central concern, not an afterthought.**
The connection health engine refreshes tokens before they expire and escalates when it
cannot, and health is a first-class field on every connection. The single most common
reason people abandon Jetpack Social is the thing we treat as a monitored state machine.

**Per-network adaptation is the default, not a paid upgrade.** The composer prepares each
network separately — character limits, hashtag placement, aspect ratios — and returns a
preview of exactly what each will publish. Jetpack charges for this; we cannot switch it
off.

**Nothing publishes twice.** Four independent layers, including a reconciliation check
before any ambiguous retry. "It posted twice" is the other complaint that makes people
uninstall.

**When something fails, the reason is a sentence you can act on.** Every error carries a
stable code, whether retrying helps, and a machine-readable next action — and now a
documentation page per code. The competing plugins' characteristic failure is silence.

---

## The strategy: one engine, four front doors

The mistake would be building four integrations. Every platform rule — every character
limit, aspect ratio, hashtag convention — must live in exactly one place, because a rule
compiled into a WordPress plugin is wrong the week a network changes it, and stays wrong on
every site until each one updates. That is precisely why the incumbents break.

So there is one endpoint, `POST /v1/articles/compose`, and every integration is a thin
client of it:

```
                    ┌─────────────────────────────┐
 WordPress plugin ──┤                             │
 Wix / site builder ┤  POST /v1/articles/compose  ├── per-network preview
 Chrome extension ──┤   (derive · media · adapt)  │   + publish_override
 ChatGPT / Claude ──┤                             │
                    └─────────────────────────────┘
                                   │
                            POST /v1/posts
```

Send a headline, a URL, a body, optionally a featured image and tags. Get back what each
network would publish and a `publish_override` per destination. The integration never
counts a character.

### What the derivation does, and refuses to do

It **selects, trims and assembles words the author already wrote** — their excerpt first,
then the meta description, then the opening sentences — and reports every choice it made.

It **never writes copy.** No hook generation, no rephrasing, no "🚀 Excited to share…".
Three consequences, all of them the point:

1. It works with **no model provider configured**, so this ships now rather than waiting.
2. It costs nothing per share, so it can stay in a free tier that competes with Jetpack.
3. A share never quietly puts words in somebody's mouth. Rewriting is a model call an
   author reviews (plan §63R), not something a share button does on their behalf.

Two details that separate it from every auto-poster's output: it cuts on **sentence
boundaries**, never mid-clause with an ellipsis; and it **omits the headline when the
summary already opens with it**, which is what produces the tell-tale "How to bake bread —
How to bake bread is a guide to…".

---

## Sequencing, and why

### 1. WordPress — first, and by a distance

Largest addressable group, worst-served, and the complaints name our existing strengths. A
plugin is ~400 lines because it contains no platform logic: collect what WordPress already
knows, show the preview, publish what was approved.

Three decisions in it worth keeping:

- Hooked to `transition_post_status`, not `save_post`. It is the only hook that
  distinguishes *becoming* published from being edited while published — Blog2Social's
  most-reported bug is sharing again on every save.
- Connection health is shown **on the settings screen**, next to each destination. People
  find out a connection needs attention while looking at a settings page, rather than from
  a post that never appeared.
- It never asks the author to write a social caption. A plugin whose value depends on extra
  work gets deactivated.

**To ship:** a WordPress.org listing (free, which is how anyone finds it), a settings
screen screenshot set, and the readme.txt the directory requires. FS Poster's absence from
the directory is the gap.

### 2. Agent connectors — already done, needs to be easier to connect

`share_article` is live as an MCP tool, so ChatGPT, Claude and any MCP client can share an
article today. The endpoint is `/mcp`, authenticated with the same API key.

The gap is not capability, it is the first ninety seconds: competitors advertise
**one-click OAuth**, and we ask somebody to create an API key and paste it. That is the
next thing to build here — not more tools.

### 3. Chrome extension — cheapest to build, best demo

The page already has everything the endpoint wants: `og:title`, `og:description`,
`og:image`, the canonical URL. The extension reads the metadata a page already publishes,
posts it to the same endpoint, and shows the same preview. It is a few hundred lines and it
works on any site, including ones with no plugin — which makes it the answer for Wix, Ghost,
Squarespace and everything else, without building a per-platform app for each.

### 4. Site-builder apps — last, and only where a marketplace justifies it

Wix and Squarespace app submissions are weeks of review each for audiences far smaller than
WordPress's. The Chrome extension covers their users functionally on day one. Build the app
when a marketplace listing is worth the review queue, not before.

---

## What has to stay true

**Ease of use is the whole thesis.** The measure is not features, it is: *how long from
installing to a post appearing on the right networks, without reading anything?* Everything
above is subordinate to that number.

Concretely, that means:

- The free tier must include auto-share on publish and per-network adaptation. Both
  competitors put one of those behind payment, and both are why people rate them one star.
- Nothing may require writing a caption, choosing a format, or understanding what a
  destination is before the first share works.
- Every failure must say what happened and what to do, on the screen where somebody is
  already looking.
