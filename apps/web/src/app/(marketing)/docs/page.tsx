import Link from 'next/link';

import { breadcrumbSchema, jsonLd, pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'API documentation',
  description:
    'Reference for the GainingSocial REST API: authentication, profiles, connections, media ' +
    'uploads, preflight validation, publishing and webhooks. Full OpenAPI specification available.',
  path: '/docs',
});

/**
 * Documentation index.
 *
 * Genuinely useful documentation is the main lever for off-page SEO in a developer
 * product: it is what other people link to. A page of feature bullets earns no links; a
 * page that answers "how do I actually do this" does.
 */

const SECTIONS = [
  {
    heading: 'Authentication',
    body: 'Every request carries an API key as a bearer token. The key determines the tenant and whether it acts on test or live data — neither can be named by the caller. Dashboard users authenticate with a session instead, and the two are never interchangeable.',
    endpoints: ['GET /v1/me', 'POST /v1/api-keys', 'GET /v1/api-keys'],
  },
  {
    heading: 'Profiles',
    body: 'A profile is the brand, client or creator identity you publish on behalf of. Everything publishable belongs to one. Supplying your own identifier makes creation naturally idempotent.',
    endpoints: ['POST /v1/profiles', 'GET /v1/profiles', 'PATCH /v1/profiles/{id}'],
  },
  {
    heading: 'Connections and destinations',
    body: 'A connection is one authorisation with a network. A destination is a specific place you can publish — a page, a board, a channel. One connection often yields several destinations, which is why they are separate objects.',
    endpoints: [
      'GET /v1/connections',
      'GET /v1/connections/{id}/destinations',
      'POST /v1/connections/{id}/disconnect',
    ],
  },
  {
    heading: 'Capabilities',
    body: 'Ask what is possible before composing. Generic capabilities describe the platform; effective capabilities describe one specific connected account, narrowed by granted permissions, account type and approval state — and every removed capability explains why.',
    endpoints: [
      'GET /v1/platforms',
      'GET /v1/platforms/{provider}/capabilities',
      'GET /v1/destinations/{id}/capabilities',
    ],
  },
  {
    heading: 'Media',
    body: 'Upload files straight to storage through a signed URL rather than through the API, then confirm. Files are inspected for their real dimensions, duration and format, and validation uses those rather than anything the client claimed.',
    endpoints: ['POST /v1/media/uploads', 'POST /v1/media/uploads/{id}/complete', 'GET /v1/media/{id}'],
  },
  {
    heading: 'Preflight and publishing',
    body: 'Preflight takes exactly the same body as publishing and performs no side effects, so it is safe to call as often as you like. Publishing returns immediately with a status you can watch — reliable delivery never depends on your process staying alive.',
    endpoints: ['POST /v1/posts/preflight', 'POST /v1/posts', 'GET /v1/posts/{id}'],
  },
  {
    heading: 'Webhooks',
    body: 'Register an endpoint and receive a signed notification the moment something publishes, fails or retries. Delivery is at-least-once and every attempt carries the same event id, which is what makes your own deduplication possible.',
    endpoints: ['POST /v1/webhooks', 'GET /v1/webhooks/{id}/deliveries', 'POST /v1/webhooks/{id}/test'],
  },
];

export default function DocsPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'Documentation', path: '/docs' },
          ]),
        )}
      />

      <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          API documentation
        </h1>
        <p className="mt-4 text-base text-pretty text-[var(--text-muted)]">
          A REST API over HTTPS returning JSON. All timestamps are UTC. All resource identifiers
          are prefixed and opaque, never sequential.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/docs/quickstart"
            className="inline-flex min-h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-[var(--on-brand)]"
          >
            Quickstart
          </Link>
          <a
            href="https://api.gainingsocial.com/openapi.json"
            className="inline-flex min-h-10 items-center rounded-lg border px-4 text-sm font-medium"
          >
            OpenAPI specification
          </a>
        </div>

        {SECTIONS.map((section) => (
          <section key={section.heading} className="mt-12">
            <h2 className="text-xl font-semibold tracking-tight">{section.heading}</h2>
            <p className="mt-2 text-sm text-pretty text-[var(--text-muted)]">{section.body}</p>
            <ul className="mt-3 space-y-1.5">
              {section.endpoints.map((endpoint) => (
                <li key={endpoint}>
                  <code className="rounded bg-[var(--surface-sunken)] px-2 py-1 font-mono text-xs">
                    {endpoint}
                  </code>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section className="mt-12 rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-5">
          <h2 className="text-base font-semibold">Errors are built for machines as well as people</h2>
          <p className="mt-2 text-sm text-pretty text-[var(--text-muted)]">
            Every error carries a stable code, an explicit statement of whether retrying could help,
            and a machine-readable next action. Nothing requires parsing an English sentence to
            decide what to do — which matters when the caller is an AI agent rather than a person.
          </p>
        </section>
      </div>
    </>
  );
}
