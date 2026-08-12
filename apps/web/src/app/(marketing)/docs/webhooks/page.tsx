import { GuidePage } from '@/components/guide-page';
import { pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Webhooks — verify signatures and handle events safely',
  description:
    'How to receive GainingSocial webhooks: verifying the HMAC signature, tolerating ' +
    'at-least-once delivery, deduplicating by event id, replaying a failed delivery, and ' +
    'which events fire when a post publishes, fails or retries.',
  path: '/docs/webhooks',
});

/**
 * Webhook guide.
 *
 * "How do I verify a webhook signature" is a high-intent query with a genuinely correct
 * answer, and getting it wrong is a security bug rather than an inconvenience — which is
 * why the timing-safe comparison and the timestamp check are spelled out rather than left
 * to a code sample nobody reads closely.
 */

const BODY = [
  {
    heading: 'Register an endpoint',
    paragraphs: [
      'An endpoint is a URL plus the list of events you want. The signing secret is returned exactly once, when the endpoint is created. There is no endpoint that reveals it again — if you lose it, rotate it.',
      'Subscribe only to what you handle. An endpoint subscribed to everything receives traffic it ignores, and a delivery you always return 200 to without reading is indistinguishable from one you handle correctly when something later goes wrong.',
    ],
    code: `curl -X POST https://api.gainingsocial.com/v1/webhooks \\
  -H "Authorization: Bearer sk_live_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://yourapp.com/hooks/gainingsocial",
    "event_types": ["post.published", "post.failed", "connection.reauth_required"]
  }'

# The response carries "secret": "whsec_...". Store it now; it is not shown again.`,
  },
  {
    heading: 'Verify the signature before you trust anything',
    paragraphs: [
      'Every delivery carries an HMAC-SHA256 signature over the timestamp and the raw request body. Compute the same value with your signing secret and compare.',
      'Two details are load-bearing. Sign the raw body, not a re-serialized object — JSON key order is not stable across languages, so re-encoding produces a different string and a signature that never matches. And compare with a timing-safe function; a plain equality check leaks how much of the signature was correct, one byte at a time.',
      'Reject a timestamp older than about five minutes. Without that check, a signature stays valid forever, and anyone who captures one delivery can replay it indefinitely.',
    ],
    code: `import crypto from 'node:crypto';

export function verify(rawBody: string, headers: Headers, secret: string): boolean {
  const timestamp = headers.get('x-gs-timestamp') ?? '';
  const signature = headers.get('x-gs-signature') ?? '';

  // Reject anything old enough to be a replay of a captured delivery.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    // The RAW body. Re-serializing a parsed object changes the bytes.
    .update(\`\${timestamp}.\${rawBody}\`)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}`,
  },
  {
    heading: 'Expect the same event more than once',
    paragraphs: [
      'Delivery is at-least-once, deliberately. The alternative — at-most-once — drops events when your endpoint is briefly unreachable, and a missed "published" notification is worse than a repeated one.',
      'Every attempt at the same event carries the same event id. Record the ids you have processed and ignore repeats. This is the whole of deduplication, and it is your side of the contract: the delivery guarantee is meaningless if your handler is not safe to run twice.',
      'Respond 2xx quickly and do the work afterwards. A handler that publishes to a database, sends an email and then returns 200 will eventually time out, get retried, and do all of it again.',
    ],
    code: `export async function POST(request: Request) {
  const raw = await request.text();
  if (!verify(raw, request.headers, process.env.GS_WEBHOOK_SECRET!)) {
    return new Response('bad signature', { status: 400 });
  }

  const event = JSON.parse(raw);

  // Same event, redelivered — already handled.
  if (await seen(event.id)) return new Response('ok');
  await record(event.id);

  // Acknowledge first, work after. A slow handler earns a retry it does not need.
  queue.push(event);
  return new Response('ok');
}`,
  },
  {
    heading: 'What arrives, and when',
    paragraphs: [
      'Publishing is per-destination, so a post to five networks produces up to five outcome events rather than one. That is the point: four succeeding and one failing is a normal Tuesday, and collapsing it into a single status would hide which one needs attention.',
      'The events worth handling on day one are post.published, post.failed and connection.reauth_required. The last one is the difference between noticing a broken connection now and noticing it when a customer asks why nothing has posted for a fortnight.',
    ],
    code: `post.published            a target went live      carries the platform's post id and URL
post.failed               a target gave up        carries the normalized error code
post.partially_published  some targets, not all   the post as a whole
media.ready               a file finished probing
connection.reauth_required  a credential expired unrecoverably
connection.disconnected     access was revoked at the platform`,
  },
  {
    heading: 'When a delivery fails',
    paragraphs: [
      'A non-2xx response is retried with exponential backoff. Repeated failure eventually disables the endpoint rather than retrying forever, and the dashboard shows why.',
      'Every attempt is recorded with the status code and response body we received, which is usually enough to see that a deploy briefly returned 502 or that a signature check was rejecting everything. A delivery can be replayed once the endpoint is fixed, without republishing anything.',
    ],
    code: `curl https://api.gainingsocial.com/v1/webhooks/wh_.../deliveries \\
  -H "Authorization: Bearer sk_live_your_key"

curl -X POST https://api.gainingsocial.com/v1/webhook-deliveries/evt_.../replay \\
  -H "Authorization: Bearer sk_live_your_key"`,
  },
];

const FAQS = [
  {
    question: 'Why do I sometimes receive the same webhook twice?',
    answer:
      'Delivery is at-least-once by design. A network timeout after your server has already processed an event is indistinguishable, from our side, from one that never arrived — so we retry. Every attempt carries the same event id, so recording processed ids and ignoring repeats makes your handler safe.',
  },
  {
    question: 'Why does my signature check keep failing?',
    answer:
      'Almost always because the body was parsed and re-serialized before signing. JSON key order is not stable, so re-encoding produces different bytes and a different HMAC. Sign the exact raw string you received, before any JSON parsing.',
  },
  {
    question: 'Can I retrieve my webhook signing secret again?',
    answer:
      'No. It is shown once when the endpoint is created and never again, because an endpoint that can reveal its own secret turns any read-only API key leak into a forgery capability. If it is lost, rotate the secret and update your handler.',
  },
  {
    question: 'What happens if my endpoint is down for a long time?',
    answer:
      'Deliveries retry with exponential backoff for a bounded period, then the endpoint is disabled and flagged in the dashboard rather than retried indefinitely. Once it is healthy again you can replay the failed deliveries individually; replaying re-sends the notification and never republishes a post.',
  },
  {
    question: 'Do I get one webhook per post or one per network?',
    answer:
      'One per destination. A post to five networks that succeeds on four and fails on one produces four post.published events and one post.failed, plus a post.partially_published for the post as a whole. Per-destination events are what let you retry only the network that failed.',
  },
  {
    question: 'How quickly should my endpoint respond?',
    answer:
      'Within a few seconds. Acknowledge with a 2xx as soon as the signature verifies and the event id is recorded, then do the real work asynchronously. A handler that finishes its work before responding will eventually exceed the timeout and be retried, doing the work a second time.',
  },
];

export default function WebhooksGuidePage() {
  return (
    <GuidePage
      breadcrumb={{ name: 'Webhooks', path: '/docs/webhooks' }}
      heading="Webhooks"
      lead="Find out the moment a post lands, fails or needs attention — without polling. Signed, at-least-once, and replayable."
      body={BODY}
      faqs={FAQS}
      related={[
        { href: '/docs/retries', label: 'How retries and duplicate prevention work' },
        { href: '/docs/quickstart', label: 'Publish your first post' },
        { href: '/docs', label: 'API documentation' },
      ]}
    />
  );
}
