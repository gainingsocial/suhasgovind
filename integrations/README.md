# Integrations

Every integration here is a thin client of one endpoint, `POST /v1/articles/compose`.

That is the whole design. No integration contains a character limit, an aspect ratio, a
hashtag convention or a platform quirk — those live in the API, and a rule compiled into a
plugin is wrong the week a network changes it and stays wrong on every installed copy until
each one updates. It is exactly why the incumbent WordPress auto-posters break.

See [`docs/STRATEGY.md`](../docs/STRATEGY.md) for the competitive reasoning and the order
these ship in.

## The shared call

```http
POST /v1/articles/compose
Authorization: Bearer sk_live_…

{
  "profile_id": "pro_…",
  "article": {
    "title": "How we cut publishing latency in half",
    "url": "https://blog.example.com/latency",
    "content": "<p>We shipped a change…</p>",
    "excerpt": "Optional. Preferred over anything derived.",
    "featured_image_url": "https://blog.example.com/hero.jpg",
    "tags": ["engineering", "social media"]
  },
  "targets": [{ "destination_id": "dst_…" }]
}
```

Back comes what each network would publish, plus a `publish_override` per destination to
hand straight to `POST /v1/posts`. The integration never counts a character.

It **never writes copy** — it selects and trims words the author already wrote, preferring
their excerpt, then the meta description, then the opening sentences, and reports every
choice in `derived.notes`. So it needs no model provider, costs nothing per share, and
never quietly rephrases anybody.

## What is here

| Integration | Status | Notes |
| --- | --- | --- |
| [`wordpress/`](./wordpress) | Built | No platform logic. Auto-share, evergreen re-sharing, UTM tracking, bulk share. Needs a WordPress.org listing to ship |
| Agent connectors | Live | `share_article` on the `/mcp` endpoint — works in ChatGPT, Claude and any MCP client today |
| [`chrome/`](./chrome) | Built | Reads the page's own metadata; covers Wix, Ghost, Squarespace and everything else without a per-platform app. Needs a Web Store listing to ship |
| Wix / Squarespace apps | Not built | Deliberately last — weeks of marketplace review for audiences the extension already serves |

## WordPress

Copy the whole `wordpress/` directory into `wp-content/plugins/gainingsocial/`, activate,
and paste an API key under **GainingSocial** in the admin menu.

A test key can never publish to a real account, so it is safe to try first.

### What it does beyond posting on publish

| | Why it is here |
| --- | --- |
| Shares in the background | Two API calls inside `transition_post_status` added up to 40s to a publish click. It queues instead. |
| Re-shares the archive | Most of a post's potential audience never sees it on the day. This is the whole premise of the most-installed plugin in the category. |
| Tags links for analytics | A share is worth nothing you can point at unless the traffic shows up attributed. The network name becomes `utm_source`, so each is its own row. |
| Bulk-shares the back catalogue | The reason someone installs this on an existing site. Staggered a minute apart, because a burst reads as spam. |
| Delays the first share | A window to catch a typo before it has gone to every network — the one mistake that cannot be taken back. |

### Verification

`tests/test-plugin.php` runs the logic that has a silent wrong answer — tracked-URL
construction and idempotency-key advancement — against stubbed WordPress functions:

```bash
php integrations/wordpress/tests/test-plugin.php
```

CI lints every file and runs those tests on **PHP 7.4 and 8.3**, the two ends of the
supported range. Modern syntax parses happily on 8.3 and then fatals on the shared hosting
much of WordPress still runs on, so the 7.4 leg is the one that earns its place.

**Still not exercised against a live WordPress install.** The syntax is verified and the
pure logic is tested, but nothing here has run inside a real WordPress request. Put it on a
staging site first.

## Chrome

Manifest V3. Load `chrome/` unpacked from `chrome://extensions`, then add an API key from
the extension's options page.

Click the toolbar button on any page and it reads that page's own metadata, asks the API
what each connected network would publish, and shows you — before anything goes out. The
preview is the point: every other extension in this category posts first and shows you the
result afterwards, which is when you find out one network silently dropped the link.

What it does *not* do is as deliberate: no character counting, no aspect-ratio checks, no
per-network rules of any kind. `POST /v1/articles/compose` answers all of that, so the
extension cannot drift out of step with the plugin or the agent tool.

### Extraction precedence

Open Graph, then structured data, then the page. Open Graph wins because it is the one
thing on a page written specifically to be shared — a `<title>` is routinely
`Headline | Section | Site Name`, which nobody would choose to post. The canonical URL
beats the address bar for the same class of reason: the address bar carries whatever
campaign parameters the visitor arrived with, and sharing those credits our own traffic to
whoever last linked the page.

### Permissions

`activeTab` and `host_permissions` limited to our own API — nothing else. A publishing
extension that asks for `<all_urls>` is requesting to read every page the person ever
visits, and both reviewers and users treat it accordingly. `activeTab` grants the same
reach for the one tab being shared, only at the moment the button is clicked.

### Verification

```bash
pnpm test -- integrations/chrome
```

24 checks: extraction precedence against real page shapes, and a manifest check that every
referenced file exists, that no code is remotely hosted, and that the popup neither
evaluates strings nor assigns `innerHTML` — page-controlled text reaches that UI.

The icons are derived from the brand master rather than drawn for this surface, so the
extension in a toolbar and the site in a tab are recognisably the same product:

```bash
pnpm brand:icons     # regenerate every icon in the product from assets/brand/
```

`pnpm brand:check` runs in CI and fails if the committed icons no longer match the master.

**Not yet loaded into a real Chrome profile.** The logic is tested and the manifest is
validated, but the browser APIs it calls have not been exercised.
