import { GuidePage } from '@/components/guide-page';
import { pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Retries and duplicate prevention — how posts are delivered exactly once',
  description:
    'Why a social publishing API can post twice, and the four layers that stop it here: ' +
    'idempotency keys, content fingerprints, target leases and post-timeout reconciliation. ' +
    'Includes which errors are safe to retry and which are not.',
  path: '/docs/retries',
});

/**
 * Retry and duplicate-prevention guide.
 *
 * The single most valuable page on the site to get right: "posted twice" is the failure
 * competitors are known for (plan §2.2), so the page that explains why it does not happen
 * here is both a ranking target and the argument for the product.
 */

const BODY = [
  {
    heading: 'Why duplicate posts happen at all',
    paragraphs: [
      'A publish request that times out is genuinely ambiguous. The platform may have created the post and lost the response on the way back, or it may never have received the request. From the caller\'s side these are identical, and only one of them is safe to retry.',
      'Systems that retry blindly post twice. Systems that never retry lose posts. Neither is acceptable, so the ambiguity has to be resolved rather than guessed at — which means asking the platform what actually happened before deciding.',
    ],
  },
  {
    heading: 'Layer 1 — your idempotency key',
    paragraphs: [
      'POST /v1/posts requires an Idempotency-Key header. It is not optional, because a published post cannot be un-published and the API refuses to accept a request it cannot deduplicate.',
      'Replaying the same key with the same body returns the original response instead of creating a second post. Replaying it with a different body is rejected outright — that combination is always a bug, and silently honouring it would publish something nobody intended.',
      'Use a key derived from your own work item, not a fresh UUID per attempt. A UUID generated inside your retry loop changes on every attempt and deduplicates nothing.',
    ],
    code: `curl -X POST https://api.gainingsocial.com/v1/posts \\
  -H "Authorization: Bearer sk_live_your_key" \\
  -H "Idempotency-Key: campaign-2026-08-launch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "profile_id": "pro_...",
    "content": { "text": "We are launching today.", "media_ids": [] },
    "targets": [{ "destination_id": "dst_..." }]
  }'

# Same key, same body  -> the original post, not a second one.
# Same key, different body -> 409 IDEMPOTENCY_KEY_REUSED.`,
  },
  {
    heading: 'Layer 2 — the duplicate content guard',
    paragraphs: [
      'Even with distinct keys, the same words going to the same destination within a short window is far more often a scheduler firing twice than a deliberate repost. That is refused with DUPLICATE_CONTENT_BLOCKED.',
      'It is a guard, not a platform rule, so the deliberate case stays available: set allow_duplicate: true and it publishes. The default protects the accident; the flag serves the intent.',
    ],
  },
  {
    heading: 'Layer 3 — one worker, one target',
    paragraphs: [
      'Internally each destination on a post is leased before anything is sent. Only the worker holding the lease can publish that target, so a queue that delivers the same message twice — which every at-least-once queue eventually does — cannot produce two publish attempts running side by side.',
      'This is invisible from the outside, and that is the point. It is what makes the delivery guarantee survive a worker being restarted mid-publish.',
    ],
  },
  {
    heading: 'Layer 4 — reconciliation after an ambiguous failure',
    paragraphs: [
      'When a publish times out, nothing is retried until the platform has been asked what happened. Where the platform can be asked directly — a media container with a known id, a publish job with a status endpoint — the answer is definitive. Where it cannot, recent posts are searched for a match.',
      'The result is one of three things: found, in which case the existing post is adopted and nothing is republished; absent, in which case retrying is provably safe; or indeterminate, in which case nothing is retried and a human is told.',
      'Indeterminate is a real outcome, not a failure of the design. Some platforms genuinely cannot answer the question — a post with no text cannot be identified by searching for its text. Reporting that honestly is better than a confident guess that duplicates a post.',
    ],
    code: `curl https://api.gainingsocial.com/v1/posts/pst_.../timeline \\
  -H "Authorization: Bearer sk_live_your_key"

# The timeline shows every attempt: which provider, which try, how long it
# took, what it returned, and whether reconciliation adopted an existing post.`,
  },
  {
    heading: 'Which errors are safe to retry',
    paragraphs: [
      'Every error carries a retryable boolean computed from the error taxonomy, not from the HTTP status. The two disagree often enough that guessing from the status code is a real source of bugs — two 409s make the point: a request still in progress is retryable, a duplicate-content refusal is not.',
      'Three codes describe an outcome that is unknown rather than failed: PROVIDER_TIMEOUT, POSSIBLE_DUPLICATE and RECONCILIATION_REQUIRED. None of them should be retried by a caller. The engine is already resolving them, and a client retry races that process — the prize for winning is a duplicate post.',
    ],
    code: `{
  "error": {
    "code": "PROVIDER_TIMEOUT",
    "retryable": false,
    "agent_action": "wait_for_reconciliation",
    "message": "The provider did not respond in time.",
    "request_id": "req_..."
  }
}`,
  },
  {
    heading: 'What you should do in your own code',
    paragraphs: [
      'Send a stable idempotency key tied to your work item. Retry only what is marked retryable. Honour retry_after, which is an absolute UTC timestamp rather than a duration, so there is no ambiguity about when the clock started.',
      'The TypeScript SDK does all three by default, including reusing a single key across its own retry attempts. If you are calling the API directly, those are the three rules worth implementing.',
    ],
  },
];

const FAQS = [
  {
    question: 'Can GainingSocial post the same thing twice?',
    answer:
      'Four independent layers exist to prevent it: a required idempotency key, a content fingerprint guard, an internal lease so only one worker can publish a given destination, and reconciliation that asks the platform what happened before retrying an ambiguous failure. No system can promise exactly-once against platforms that do not offer it, so where the outcome genuinely cannot be determined the post is held and a human is told rather than retried on a guess.',
  },
  {
    question: 'Why is my Idempotency-Key rejected as reused?',
    answer:
      'The key was already used with a different request body. That combination is always a bug — either the key is not as unique as intended, or the body changed between attempts. Replaying a key with an identical body is fine and returns the original post.',
  },
  {
    question: 'Why is a timeout not retryable?',
    answer:
      'Because a timeout cannot distinguish "never arrived" from "published, response lost". Retrying the second case creates a duplicate. Instead the engine reconciles — it asks the platform whether the post exists — and then either adopts it or retries once it has proved nothing was created.',
  },
  {
    question: 'What does an indeterminate reconciliation mean for my post?',
    answer:
      'It means the platform could not answer whether the post exists, so the target is held rather than retried and surfaced for a human decision. This is uncommon and usually specific to a platform and content shape — for example, a media-only post on a platform whose only lookup is by text.',
  },
  {
    question: 'How do I deliberately post the same content twice?',
    answer:
      'Set allow_duplicate: true on the post. The guard exists to catch a scheduler firing twice, not to prevent a genuine repost, so the deliberate case is one flag away.',
  },
  {
    question: 'Does a failed post to one network affect the others?',
    answer:
      'No. Each destination is published and retried independently, and the post reports a per-destination status. A single network being down does not hold up the rest, and you can retry just the target that failed rather than the whole post.',
  },
];

export default function RetriesGuidePage() {
  return (
    <GuidePage
      breadcrumb={{ name: 'Retries', path: '/docs/retries' }}
      heading="Retries and duplicate prevention"
      lead="Publishing twice is the failure mode this category is known for. Four layers make sure it does not happen here — and where certainty is impossible, the post is held rather than guessed at."
      body={BODY}
      steps={[
        {
          name: 'Your idempotency key',
          text: 'Required on every publish. Replaying it returns the original post instead of creating a second one.',
        },
        {
          name: 'Content fingerprint',
          text: 'The same content to the same destination within a short window is refused unless you opt in.',
        },
        {
          name: 'Target lease',
          text: 'Only one worker can publish a given destination, so a redelivered queue message cannot double-publish.',
        },
        {
          name: 'Reconciliation',
          text: 'After an ambiguous failure the platform is asked what happened before anything is retried.',
        },
      ]}
      faqs={FAQS}
      related={[
        { href: '/docs/webhooks', label: 'Receiving webhooks safely' },
        { href: '/features/reliability', label: 'How reliability works' },
        { href: '/docs/quickstart', label: 'Publish your first post' },
      ]}
    />
  );
}
