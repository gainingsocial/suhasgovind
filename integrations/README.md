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
| [`wordpress/`](./wordpress) | Built | ~400 lines, no platform logic. Needs a WordPress.org listing to ship |
| Agent connectors | Live | `share_article` on the `/mcp` endpoint — works in ChatGPT, Claude and any MCP client today |
| Chrome extension | Not built | Reads `og:*` from the page; covers Wix, Ghost, Squarespace and everything else without a per-platform app |
| Wix / Squarespace apps | Not built | Deliberately last — weeks of marketplace review for audiences the extension already serves |

## WordPress

Copy `wordpress/gainingsocial.php` into `wp-content/plugins/gainingsocial/`, activate, and
paste an API key under **Settings → GainingSocial**.

A test key can never publish to a real account, so it is safe to try first.

**Not yet verified against a live WordPress install.** The file is structurally sound and
follows the escaping, nonce and capability conventions the plugin directory requires, but
no PHP runtime was available here to parse it or exercise it against a real site. Run it on
a staging site before it goes anywhere near a production one.
