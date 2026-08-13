import Link from 'next/link';

import { ClosingCta, FaqList, Section, SectionHeader } from '@/components/marketing';
import { PLATFORMS } from '@/lib/platforms';
import { breadcrumbSchema, faqSchema, jsonLd, pageSeo, type Faq } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Pricing',
  description:
    'GainingSocial is free while in development. What is metered today, what each social ' +
    'network charges for API access, and how billing will work when it starts.',
  path: '/pricing',
});

/**
 * Pricing.
 *
 * There is no price list yet, and inventing one would be worse than saying so: a developer
 * who builds against a number we made up finds out later, and that is the single most
 * expensive kind of trust to lose.
 *
 * What this page can do honestly is answer the questions behind the search. What does it
 * cost right now (nothing). What will be measured when it does cost something (already
 * being recorded, and listed here). And which networks charge on their own account, which
 * is a real cost that applies whoever you buy publishing from.
 */

const METERED = [
  {
    unit: 'Connected accounts',
    detail:
      'A connected social account, counted per day it exists. The clearest proxy for value in this product — an account that is connected is one you can publish to.',
  },
  {
    unit: 'Successful publishes',
    detail:
      'A publish that actually reached a network. Failed attempts are recorded for your debugging but are not the billable event.',
  },
  {
    unit: 'API requests',
    detail:
      'Every call, including preflight. Preflight performs no publishing side effects and is deliberately cheap to call, because a product that discourages validation gets more broken posts.',
  },
  {
    unit: 'Media processing and storage',
    detail:
      'Minutes processed and bytes stored per day. Transcoding a video costs real compute; a text post costs almost nothing, and the meter reflects that.',
  },
  {
    unit: 'Analytics syncs and webhook deliveries',
    detail:
      'Both are ongoing background work that continues whether or not you are calling the API.',
  },
  {
    unit: 'Content Intelligence',
    detail:
      'Source fetches, items processed, repurpose jobs and model tokens in and out. Metered separately because it is optional — publishing never depends on it.',
  },
];

const FAQS: readonly Faq[] = [
  {
    question: 'What does GainingSocial cost right now?',
    answer:
      'Nothing. It is free while in development. Usage is being metered so that billing can start without a migration later, but no meter is currently attached to an invoice.',
  },
  {
    question: 'Do the social networks charge for API access?',
    answer:
      'Almost none of them. Bluesky, LinkedIn, Meta (Facebook, Instagram, Threads), TikTok, YouTube, Pinterest, Discord, Telegram and Google Business Profile all provide free API access to approved applications. X is the only major network that requires a paid tier to publish, and that cost is passed through rather than absorbed.',
  },
  {
    question: 'Will there be a free tier when pricing starts?',
    answer:
      'Yes — a developer and test tier. Test keys can never touch live accounts, so a free tier that covers building and testing costs us very little and is the only sane way to let somebody evaluate the product.',
  },
  {
    question: 'How will I be charged — per post or per account?',
    answer:
      'The intended shape is a base plan with included profiles and connections, and overage on connected accounts and media processing. That is not final. What is settled is that metering happens by resource, so whatever the commercial model becomes, it is computed from immutable usage events rather than a counter someone can edit.',
  },
  {
    question: 'Can I bring my own developer applications?',
    answer:
      'Yes. Enterprise customers who prefer to use their own Meta, LinkedIn or TikTok applications can register them, which changes nothing about how you call the API. It also means your rate limits are your own rather than shared.',
  },
  {
    question: 'Will I be told before billing starts?',
    answer:
      'Yes, well in advance and before any charge. Nothing switches from free to paid without notice, and usage data from the free period is visible to you first so you can see what a bill would have looked like.',
  },
];

export default function PricingPage() {
  const paidNetworks = PLATFORMS.filter((platform) => platform.cost === 'Paid');
  const freeNetworks = PLATFORMS.filter((platform) => platform.cost === 'Free');

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'Pricing', path: '/pricing' },
          ]),
        )}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(faqSchema(FAQS))} />

      <div className="mx-auto max-w-6xl px-4 pt-14 pb-10 sm:px-6 sm:pt-20">
        <div className="max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-[2.6rem] sm:leading-[1.1]">
            Free while in development
          </h1>
          <p className="mt-5 text-lg text-pretty text-[var(--text-muted)]">
            There is no price list yet, and publishing one we had not decided on would be worse
            than saying so. Here is what is true today, what is being measured for when that
            changes, and what the networks themselves charge.
          </p>
        </div>

        <div className="mt-10 rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-6 sm:p-8">
          <p className="text-sm font-medium text-[var(--brand-text)]">Today</p>
          <p className="mt-3 text-4xl font-semibold tracking-tight">£0</p>
          <p className="mt-3 max-w-2xl text-base text-pretty text-[var(--text-muted)]">
            No card, no trial clock, no per-post charge. Every capability is switched on:
            publishing, scheduling, preflight, media, webhooks, analytics, the inbox and the MCP
            layer. The limits that exist are the platforms&rsquo; own, not ours.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/docs/quickstart"
              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-5 text-sm font-medium text-[var(--on-brand)] transition-colors hover:bg-brand-500"
            >
              Start building
            </Link>
            <Link
              href="/features"
              className="inline-flex min-h-11 items-center justify-center rounded-lg border px-5 text-sm font-medium transition-colors hover:bg-[var(--surface-sunken)]"
            >
              What you get
            </Link>
          </div>
        </div>
      </div>

      <Section tone="sunken">
        <SectionHeader
          eyebrow="Metering"
          heading="What is being measured, so nothing changes underneath you"
          lead="Usage events are recorded now and aggregated immutably. When pricing arrives it will be computed from these, which is why there is no risk of a bill appearing for something that was never counted."
          align="left"
        />

        <dl className="mt-10 grid gap-x-10 gap-y-7 md:grid-cols-2">
          {METERED.map((item) => (
            <div key={item.unit} className="border-t pt-5">
              <dt className="text-base font-semibold">{item.unit}</dt>
              <dd className="mt-2 text-[15px] leading-relaxed text-pretty text-[var(--text-muted)]">
                {item.detail}
              </dd>
            </div>
          ))}
        </dl>

        <p className="mt-10 max-w-2xl text-base text-pretty text-[var(--text-muted)]">
          Your own usage is visible in the dashboard and through{' '}
          <code className="rounded bg-[var(--surface-raised)] px-1.5 py-0.5 font-mono text-[0.9em]">
            GET /v1/usage
          </code>
          , so you can see exactly what a bill would be computed from before one exists.
        </p>
      </Section>

      <Section>
        <SectionHeader
          eyebrow="Platform costs"
          heading="What the networks charge on their own account"
          lead="This applies whoever you buy publishing from, so it is worth knowing before you plan around a network."
          align="left"
        />

        <div className="mt-10 grid gap-5 md:grid-cols-2">
          <div className="rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-6">
            <h3 className="text-base font-semibold">Free API access</h3>
            <p className="mt-2 text-sm text-[var(--text-muted)]">
              {freeNetworks.length} of the {PLATFORMS.length} supported networks charge nothing for
              publishing access, once an application is approved.
            </p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {freeNetworks.map((platform) => (
                <li
                  key={platform.id}
                  className="rounded-full bg-[var(--surface-sunken)] px-2.5 py-1 text-xs text-[var(--text-muted)]"
                >
                  {platform.name}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-6">
            <h3 className="text-base font-semibold">Paid API access</h3>
            <p className="mt-2 text-sm text-[var(--text-muted)]">
              {paidNetworks.map((platform) => platform.name).join(', ')} requires a paid developer
              tier before anything can be published through its API. That cost is the network&rsquo;s,
              and it is passed through rather than hidden in a plan.
            </p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {paidNetworks.map((platform) => (
                <li
                  key={platform.id}
                  className="rounded-full bg-warn-100 px-2.5 py-1 text-xs text-warn-600"
                >
                  {platform.name}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section tone="sunken">
        <SectionHeader heading="Pricing questions" align="left" />
        <FaqList faqs={FAQS} />
      </Section>

      <ClosingCta
        heading="Build against it while it is free"
        lead="Bluesky needs no approval from anyone, so you can have a published post today and decide about everything else later."
        primary={{ href: '/docs/quickstart', label: 'Read the quickstart' }}
        secondary={{ href: '/platforms', label: 'See every network' }}
      />
    </>
  );
}
