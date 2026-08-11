import { breadcrumbSchema, howToSchema, jsonLd, pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Quickstart — publish your first post',
  description:
    'Publish to a social network through the API in seven steps: create a key, add a profile, ' +
    'connect an account, choose destinations, preflight, publish, watch it land. Includes ' +
    'copyable curl examples.',
  path: '/docs/quickstart',
});

/**
 * Quickstart.
 *
 * A "how do I actually do this" page, which is both what developers want and the kind of
 * page that earns inbound links. The HowTo structured data makes it eligible for a
 * step-by-step search result, which occupies far more space than a plain blue link.
 */

const STEPS = [
  {
    name: 'Create an API key',
    text: 'Sign in to the dashboard and create a key. Test keys can never touch live accounts, so there is no way to publish to a real audience by accident while developing.',
    code: `curl https://api.gainingsocial.com/v1/me \\
  -H "Authorization: Bearer sk_test_your_key"`,
  },
  {
    name: 'Create a profile',
    text: 'A profile is the brand or client you publish on behalf of. Supplying your own external_id makes this naturally idempotent — repeating it conflicts rather than creating a duplicate.',
    code: `curl -X POST https://api.gainingsocial.com/v1/profiles \\
  -H "Authorization: Bearer sk_test_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Acme Coffee","external_id":"acme","timezone":"Europe/London"}'`,
  },
  {
    name: 'Connect a social account',
    text: 'Start an authorization and branch on what comes back. `completion: "redirect"` means send the person to authorization_url and wait for the callback. `completion: "credential"` means the platform has no consent screen — collect the fields it names and post them back. Branching on this rather than on the platform name means your code does not need a list of which platforms use OAuth.',
    code: `curl -X POST https://api.gainingsocial.com/v1/connections/authorize \\
  -H "Authorization: Bearer sk_test_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "profile_id": "pro_...",
    "provider": "bluesky",
    "redirect_url": "https://yourapp.com/social/done"
  }'`,
  },
  {
    name: 'Choose where it publishes',
    text: 'One connection often yields several destinations — a Meta login returns every Page you manage. When it returns more than one, the connection stays deliberately unusable until you choose: publishing to every Page somebody happens to administer is not a mistake you can take back.',
    code: `curl https://api.gainingsocial.com/v1/connections/con_.../destinations \\
  -H "Authorization: Bearer sk_test_your_key"

curl -X POST https://api.gainingsocial.com/v1/connections/con_.../destinations/select \\
  -H "Authorization: Bearer sk_test_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"destination_ids":["dst_..."]}'`,
  },
  {
    name: 'Check the post before publishing',
    text: 'Preflight takes exactly the same body as publishing and performs no side effects. It returns a verdict per destination, the field at fault, and where possible a concrete fix.',
    code: `curl -X POST https://api.gainingsocial.com/v1/posts/preflight \\
  -H "Authorization: Bearer sk_test_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "profile_id": "pro_...",
    "content": { "text": "We are launching today.", "media_ids": [] },
    "targets": [{ "destination_id": "dst_..." }]
  }'`,
  },
  {
    name: 'Publish',
    text: 'The Idempotency-Key header is required. A duplicate published post cannot be undone, so the API insists on something to deduplicate on. It returns 202 immediately — publishing continues in the background.',
    code: `curl -X POST https://api.gainingsocial.com/v1/posts \\
  -H "Authorization: Bearer sk_test_your_key" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "profile_id": "pro_...",
    "content": { "text": "We are launching today.", "media_ids": [] },
    "targets": [{ "destination_id": "dst_..." }]
  }'`,
  },
  {
    name: 'Watch it go live',
    text: 'Fetch the post to see each destination independently, or register a webhook to be told the moment one publishes or fails. The timeline shows every attempt in the order it happened — which provider, on which try, after how long, and with what error.',
    code: `curl https://api.gainingsocial.com/v1/posts/pst_... \\
  -H "Authorization: Bearer sk_test_your_key"

curl https://api.gainingsocial.com/v1/posts/pst_.../timeline \\
  -H "Authorization: Bearer sk_test_your_key"`,
  },
];

export default function QuickstartPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'Documentation', path: '/docs' },
            { name: 'Quickstart', path: '/docs/quickstart' },
          ]),
        )}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          howToSchema({
            name: 'Publish your first social media post through the API',
            description:
              'Create an API key, add a profile, connect a social account, validate the post and publish it.',
            steps: STEPS.map((step) => ({ name: step.name, text: step.text })),
          }),
        )}
      />

      <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Publish your first post
        </h1>
        <p className="mt-4 text-base text-pretty text-[var(--text-muted)]">
          Seven steps from nothing to a published post. Bluesky needs no approval from anyone, so
          you can complete this today and the same code reaches every other network as its approval
          lands.
        </p>

        <ol className="mt-10 space-y-8">
          {STEPS.map((step, index) => (
            <li key={step.name}>
              <div className="flex items-center gap-3">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-100 text-sm font-semibold text-brand-600">
                  {index + 1}
                </span>
                <h2 className="text-lg font-semibold tracking-tight">{step.name}</h2>
              </div>
              <p className="mt-2 text-sm text-pretty text-[var(--text-muted)]">{step.text}</p>
              {/* Horizontal scroll on the block itself, so a long command never makes the
                  whole page scroll sideways on a phone. */}
              <pre className="mt-3 overflow-x-auto rounded-[var(--radius-card)] border bg-[var(--surface-sunken)] p-4">
                <code className="font-mono text-xs whitespace-pre">{step.code}</code>
              </pre>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
