# `@gs/sdk` — TypeScript SDK

The typed client for the GainingSocial API. Zero dependencies, built on global `fetch`, so
it runs unchanged in Node 18+, Cloudflare Workers, Deno, Bun and the browser.

```ts
import { GainingSocial } from '@gs/sdk';

const gs = new GainingSocial({ apiKey: process.env.GS_API_KEY! });

const post = await gs.posts.create({
  profile_id: 'pro_...',
  content: { text: 'Shipping today.', media_ids: [] },
  targets: [{ destination_id: 'dst_...' }],
});

console.log(post.status); // "queued"
```

## Three things to know first

**`posts.create` returns a queued post, never a published one.** Publishing happens on a
queue (plan §85 Rule 10), so nothing here will ever hand back `published` directly. Wait for
the `post.published` webhook, or poll `posts.get`.

**Errors are one type.** `GainingSocialError` carries the API's whole envelope. Branch on
`code`, never on `message` — codes are stable, messages are prose.

```ts
import { isGainingSocialError } from '@gs/sdk';

try {
  await gs.posts.create(input);
} catch (error) {
  if (isGainingSocialError(error)) {
    if (error.code === 'CONNECTION_REAUTH_REQUIRED') {
      await promptReconnect(error.destinationId);
    }
    // Quote this to support; it identifies the exact request.
    console.error(error.requestId, error.agentAction);
  }
}
```

**Retries are automatic, and only where they are safe.** The SDK retries what the API marks
`retryable`, honours `retry_after`, backs off exponentially with jitter, and reuses a single
idempotency key across its attempts — so a retry can never become a second post.

## Preflight before you publish

`posts.preflight` has no side effects and is free to call. It is the call that replaces the
compose-submit-reject-guess loop: it tells you what every target will reject *before* you
publish anything.

```ts
const check = await gs.posts.preflight(input);

if (!check.valid) {
  for (const target of check.targets.filter((t) => !t.valid)) {
    for (const error of target.errors) {
      // `agent_action` is machine-readable: shorten_text, attach_media, remove_link…
      console.log(target.provider, error.code, error.agent_action);
    }
  }
}
```

## Capabilities, not guesswork

Ask what a destination can do rather than hard-coding platform rules that change.

```ts
const caps = await gs.platforms.destinationCapabilities('dst_...');

caps.constraints.max_text_length; // 280 on X, 3000 on LinkedIn
caps.publishing.video;            // false if this connection lacks the scope

// Every capability that is off explains itself.
for (const r of caps.restrictions) {
  console.log(r.capability, r.reason, r.agent_action);
}
```

The distinction between generic and effective capability is load-bearing.
`platforms.capabilities(provider)` says what the platform can do at all;
`platforms.destinationCapabilities(id)` says what *this* connected account can do, narrowed
by granted scopes, account type and platform approval state. Never infer the second from the
first — only the adapter knows that an unaudited TikTok client cannot post publicly.

## Pagination

Every `list` has an `autoList` twin that pages transparently.

```ts
// One page, for a dashboard.
const page = await gs.posts.list({ limit: 25 });

// Every page, for a script.
for await (const post of gs.posts.autoList({ profile_id: 'pro_...' })) {
  console.log(post.id);
}
```

## Uploading media

`media.upload` wraps the three-step protocol — request a URL, PUT the bytes, mark complete —
because getting it wrong leaves media rows that never become publishable. The bytes go
straight to storage and never through the API.

```ts
const media = await gs.media.upload(file, {
  profile_id: 'pro_...',
  filename: 'launch.jpg',
  mime_type: 'image/jpeg',
  alt_text: 'The new dashboard',
});

await gs.posts.create({
  profile_id: 'pro_...',
  content: { text: 'Out now.', media_ids: [media.id] },
  targets: [{ destination_id: 'dst_...' }],
});
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | — | Required. `sk_live_…` or `sk_test_…`; the environment is encoded in the key. |
| `baseUrl` | `https://api.gainingsocial.com` | For staging or self-hosted deployments. |
| `timeoutMs` | `30000` | Per attempt. Preflight across several providers is the slow case. |
| `maxRetries` | `2` | Retries of a retryable failure, on top of the first attempt. |
| `appName` | — | Appended to the User-Agent so your integration is attributable in logs. |
| `fetch` | global | Inject one for tests, or for a runtime without a global. |

Per-request, `idempotencyKey`, `signal` and `timeoutMs` can be overridden:

```ts
await gs.posts.create(input, {
  // Your job's identity. A retry of *your job* is then deduplicated too.
  idempotencyKey: `job-${job.id}`,
  signal: abortController.signal,
});
```

## Errors worth handling explicitly

| Code | What it means | What to do |
| --- | --- | --- |
| `CONNECTION_REAUTH_REQUIRED` | The credential expired unrecoverably. | Create a connect session; the account holder must re-authorize. |
| `CONNECTION_INCOMPLETE_SETUP` | Several destinations, none chosen. | Call `connections.selectDestinations`. |
| `VALIDATION_FAILED` | A target cannot publish as composed. | Run `posts.preflight` for the per-target breakdown. |
| `DUPLICATE_CONTENT_BLOCKED` | Equivalent content went out recently. | Deliberate? Set `allow_duplicate: true`. |
| `RATE_LIMITED` | Slow down. | Already retried automatically; surfaced only after attempts are exhausted. |

The full dictionary is in [`docs/errors`](../../docs/errors/README.md).
