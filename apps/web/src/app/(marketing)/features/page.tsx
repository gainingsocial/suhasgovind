import Link from 'next/link';

import { FanOutDiagram } from '@/components/diagrams';
import {
  ClosingCta,
  FaqList,
  Section,
  SectionHeader,
  Split,
  Prose,
} from '@/components/marketing';
import { PLATFORM_COUNT } from '@/lib/platforms';
import { breadcrumbSchema, faqSchema, jsonLd, pageSeo, type Faq } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Features — everything the publishing API does',
  description:
    'Cross-platform publishing, scheduling, duplicate prevention, preflight validation, media ' +
    'auto-fit, webhooks, analytics, a unified inbox and an MCP layer for agents — what each ' +
    'one does and where it is documented.',
  path: '/features',
});

/**
 * The features hub.
 *
 * `/features` returned a 404 while `/features/publishing` and its siblings existed, which
 * is the worst version of the problem: a URL a visitor would guess, and one search engines
 * derive from the deeper pages, resolving to nothing. It is now a real hub — every
 * capability described in a paragraph a reader can evaluate, linking on to the pages that
 * go deeper.
 *
 * The capabilities without a deep page yet are listed anyway. Leaving them out would make
 * the product look smaller than it is, and each paragraph here is honest about what the
 * feature does rather than promising a page that does not exist.
 */

interface Feature {
  title: string;
  body: string;
  href?: string;
  hrefLabel?: string;
}

const CORE: readonly Feature[] = [
  {
    title: 'Publish to every network with one request',
    body: `One post, many destinations. Each network receives a version it will actually accept, and each reports its own outcome — a post that reached three networks and was rejected by the fourth is marked partly published, with the failing destination carrying the specific reason. The same request body works across all ${PLATFORM_COUNT} networks.`,
    href: '/features/publishing',
    hrefLabel: 'How publishing works',
  },
  {
    title: 'Schedule posts that actually go out',
    body: 'Send a publish time and the post goes out then. A background reconciler runs every minute looking for anything overdue — posts whose time has come, work abandoned by a process that died mid-publish — and picks it back up. Without that, a post scheduled for next week depends on one delayed message surviving seven days.',
    href: '/features/scheduling',
    hrefLabel: 'How scheduling works',
  },
  {
    title: 'The same post never goes out twice',
    body: 'Four independent layers: an idempotency key on every request, a lease on each destination while it publishes, a content fingerprint that catches accidental repeats, and a reconciliation check that looks at the account before retrying anything whose outcome was ambiguous.',
    href: '/features/reliability',
    hrefLabel: 'How duplicates are prevented',
  },
  {
    title: 'Validation before publishing, not after',
    body: 'Preflight takes the identical body as a publish and performs no side effects, so it is safe to call as often as you like. It returns a verdict per destination, the exact field at fault, and where one exists a concrete fix — the length to trim to, the aspect ratio to crop for.',
    href: '/docs/quickstart',
    hrefLabel: 'See it in the quickstart',
  },
];

const MORE: readonly Feature[] = [
  {
    title: 'Smart Universal Composer',
    body: 'Write once and see what each network would actually publish before committing — the adapted text, the media transforms, and a plain-language readiness line per destination. It never rewrites or rephrases; mechanical fixes are applied and reported, and anything needing judgement is handed back as a question.',
  },
  {
    title: 'Smart Media Auto-Fit',
    body: 'Media is inspected for its real dimensions, duration and format rather than trusted from the request, then fitted to each network’s rules. The line between fixing something quietly and asking first is drawn deliberately: a resize is mechanical, a crop that would lose half the frame is a decision.',
    href: '/docs/media',
    hrefLabel: 'Media uploads',
  },
  {
    title: 'Webhooks you can trust',
    body: 'Signed, at-least-once delivery the moment something publishes, fails or retries, with the same event id on every attempt so your own deduplication is possible. Failed deliveries retry on a published schedule and can be replayed by hand.',
    href: '/docs/webhooks',
    hrefLabel: 'Webhook delivery',
  },
  {
    title: 'Analytics and external posts',
    body: 'Metrics are normalized across networks so a view on one platform means the same thing as a view on another, and posts published outside this API are pulled in and normalized alongside the ones it created — otherwise every report has a hole in it.',
  },
  {
    title: 'A unified inbox',
    body: 'Comments and conversations from every connected network in one place, with the contact behind them resolved across platforms. Replying goes back out through the same connection that received it.',
  },
  {
    title: 'An MCP layer for agents',
    body: 'The same API reachable as agent tools, with every tool call re-entering through the API’s own front door — the same middleware, the same authentication, the same handler. An agent gets exactly the scopes its key carries and nothing more.',
  },
  {
    title: 'Agent governance and approvals',
    body: 'An agent that has not been configured to publish can draft but not send. Approval policies are explicit and server-enforced, so autonomy is something you grant rather than something a prompt can talk its way into.',
  },
  {
    title: 'Multi-tenant and white-label',
    body: 'Publish on behalf of your own customers under your own branding, including a hosted connect page they reach without ever seeing this dashboard. Tenant ownership is verified server-side on every single operation, not assumed from the request.',
    href: '/docs/multi-tenant',
    hrefLabel: 'Multi-tenant guide',
  },
  {
    title: 'Test mode and provider kill switches',
    body: 'Test keys can never touch live accounts, and simulation mode exercises the whole publishing path without contacting a network. Any provider can be switched off centrally when it starts failing, so an outage is a flag rather than a deploy.',
  },
  {
    title: 'Observability built for debugging',
    body: 'Every post carries a timeline of every attempt in the order it happened — which provider, on which try, after how long, with what error. Every response carries a request id and a trace id, including the successful ones.',
  },
];

const FAQS: readonly Faq[] = [
  {
    question: 'Is every feature available on every network?',
    answer:
      'No, and the API will not pretend otherwise. Capabilities are queryable per destination, so you can ask what a specific connected account allows — accounting for granted permissions, account type and platform approval — before composing anything. Where a network genuinely cannot do something, the capability is absent and says why.',
  },
  {
    question: 'Do I have to use the dashboard?',
    answer:
      'No. The dashboard is an API client with no privileges of its own — everything it does is a call you can make yourself. Some teams never open it; others use it to connect accounts and then drive everything from code.',
  },
  {
    question: 'Can I use a network’s own features that have no equivalent elsewhere?',
    answer:
      'Yes. A unified body covers what the networks have in common, and a provider-native options object passes platform-specific settings straight through. Unified does not mean reduced to the smallest common feature set.',
  },
  {
    question: 'What happens when a network changes its API?',
    answer:
      'Provider behaviour is versioned in a registry rather than assumed, and adapters are certified against a shared checklist before a network is called supported. When something changes underneath us, the change is contained to one adapter package rather than spread through the core.',
  },
];

export default function FeaturesPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'Features', path: '/features' },
          ]),
        )}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(faqSchema(FAQS))} />

      <div className="mx-auto max-w-6xl px-4 pt-14 pb-6 sm:px-6 sm:pt-20">
        <div className="max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-[2.6rem] sm:leading-[1.1]">
            Everything the publishing API does
          </h1>
          <p className="mt-5 text-lg text-pretty text-[var(--text-muted)]">
            The short version: one request publishes to {PLATFORM_COUNT} networks, nothing goes out
            twice, scheduled posts really go out, and every failure carries a code you can branch
            on. The longer version is below.
          </p>
        </div>
      </div>

      <Section tone="sunken">
        <Split media={<FanOutDiagram />}>
          <SectionHeader
            eyebrow="The core"
            heading="Four things that have to be right"
            align="left"
          />
          <Prose className="mt-6">
            <p>
              Everything else in this product is downstream of these four. If publishing is not
              genuinely cross-platform, if duplicates are possible, if a scheduled post can vanish
              silently, or if you only learn about a rejection after it happened, no amount of
              additional features compensates.
            </p>
          </Prose>
        </Split>

        <ul className="mt-14 grid gap-5 md:grid-cols-2">
          {CORE.map((feature) => (
            <li
              key={feature.title}
              className="flex flex-col rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-6"
            >
              <h2 className="text-lg font-semibold tracking-tight text-balance">{feature.title}</h2>
              <p className="mt-3 text-[15px] leading-relaxed text-pretty text-[var(--text-muted)]">
                {feature.body}
              </p>
              {feature.href ? (
                <Link
                  href={feature.href as never}
                  className="mt-auto pt-5 text-sm font-medium text-[var(--text)] underline underline-offset-4"
                >
                  {feature.hrefLabel} →
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section>
        <SectionHeader
          eyebrow="The rest"
          heading="What sits around publishing"
          lead="Composing, media, delivery, measurement, engagement and the agent layer. None of it is required to publish — all of it exists because publishing alone is not a product."
          align="left"
        />

        <ul className="mt-12 grid gap-x-10 gap-y-9 md:grid-cols-2 lg:grid-cols-3">
          {MORE.map((feature) => (
            <li key={feature.title} className="border-t pt-5">
              <h2 className="text-base font-semibold text-balance">{feature.title}</h2>
              <p className="mt-2.5 text-[15px] leading-relaxed text-pretty text-[var(--text-muted)]">
                {feature.body}
              </p>
              {feature.href ? (
                <Link
                  href={feature.href as never}
                  className="mt-3 inline-block text-sm font-medium text-[var(--text)] underline underline-offset-4"
                >
                  {feature.hrefLabel} →
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section tone="sunken">
        <SectionHeader heading="Common questions" align="left" />
        <FaqList faqs={FAQS} />
      </Section>

      <ClosingCta
        heading="See it working in about ten minutes"
        lead="The quickstart goes from an API key to a published post in seven steps, against a network that needs no approval from anyone."
        primary={{ href: '/docs/quickstart', label: 'Read the quickstart' }}
        secondary={{ href: '/platforms', label: 'See every network' }}
      />
    </>
  );
}
