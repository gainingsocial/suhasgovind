import { FaqList, Section, SectionHeader, ClosingCta } from '@/components/marketing';
import { PlatformMark } from '@/components/platform-marks';
import {
  PLATFORMS,
  PLATFORM_COUNT,
  STATUS_LABEL,
  STATUS_TONE,
  type PlatformStatus,
} from '@/lib/platforms';
import { breadcrumbSchema, faqSchema, jsonLd, pageSeo, type Faq } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Supported social networks',
  description:
    'Which social networks GainingSocial publishes to, what each one requires, and how long ' +
    'developer approval takes. Bluesky works immediately with no application.',
  path: '/platforms',
});

/**
 * Platform status.
 *
 * Deliberately honest about what is not available yet. A page that implies everything
 * works is the fastest way to lose a developer's trust, and a plainly stated approval
 * timeline is genuinely useful information nobody else publishes.
 *
 * Grouped by status rather than listed flat. Twelve visually identical cards made the one
 * fact a visitor came for — what can I use today — something they had to read every card
 * to work out.
 */

const GROUPS: { status: PlatformStatus; heading: string; lead: string }[] = [
  {
    status: 'available',
    heading: 'Publishing today',
    lead: 'No application, no review queue, no waiting. You can complete the quickstart against this network right now.',
  },
  {
    status: 'awaiting-approval',
    heading: 'Built, waiting on the platform',
    lead: 'The adapter is written, tested and deployed. What is outstanding is the network’s own commercial review — a business application we have submitted or are preparing, not code.',
  },
  {
    status: 'planned',
    heading: 'Implemented, application not yet started',
    lead: 'The adapter exists and passes its certification checks. These applications are queued behind the launch platforms above, because each one costs reviewer attention we would rather spend on the networks customers ask for first.',
  },
];

const FAQS: readonly Faq[] = [
  {
    question: 'Why can I publish to Bluesky but not LinkedIn yet?',
    answer:
      'Bluesky has no application process — you create an account and the API works. LinkedIn, Meta and TikTok each require a business application reviewed by the platform, which takes weeks. The code for every platform is already written; only the platform’s permission is outstanding.',
  },
  {
    question: 'Do I need my own developer accounts with each network?',
    answer:
      'For most platforms, no. You connect your social accounts and publishing happens through approved applications on your behalf. Enterprise customers who prefer to use their own Meta, LinkedIn or TikTok applications can, and no code changes are needed to do so.',
  },
  {
    question: 'Why does TikTok make posts private?',
    answer:
      'TikTok requires a separate audit for its Content Posting API. Until an application passes that audit, TikTok itself forces every post created through the API to be visible only to the creator. That is TikTok’s rule, not a limitation of this service.',
  },
  {
    question: 'Does publishing cost anything per platform?',
    answer:
      'Only X charges for the ability to publish through its API. Bluesky, LinkedIn, Meta, TikTok, YouTube, Pinterest, Discord and Google Business Profile all provide free API access to approved applications.',
  },
  {
    question: 'Does my code change when a network is approved?',
    answer:
      'No. Every adapter reads its client id and secret from the database at call time, so an approval is a configuration change rather than a deployment. A post that targets a newly approved network uses the same request body it always would.',
  },
  {
    question: 'What happens if I target a network that is not approved yet?',
    answer:
      'Authorizing a connection for it returns PROVIDER_NOT_CONFIGURED — a 503 that says the platform is not yet available, rather than a 400 implying you sent something wrong. Capabilities also report the restriction, so an agent can check before composing instead of discovering it at publish time.',
  },
];

export default function PlatformsPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'Platforms', path: '/platforms' },
          ]),
        )}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(faqSchema(FAQS))} />

      <div className="mx-auto max-w-6xl px-4 pt-14 pb-4 sm:px-6">
        <div className="max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-[2.6rem] sm:leading-[1.1]">
            Supported social networks
          </h1>
          <p className="mt-5 text-lg text-pretty text-[var(--text-muted)]">
            All {PLATFORM_COUNT} networks below are implemented and covered by the same request
            body. What differs is whether the platform has granted access yet — most require a
            business application that takes weeks, which is why they are listed by status rather
            than promised vaguely.
          </p>
        </div>

        {/* An at-a-glance count per status, so the page answers "what can I use today"
            before any card is read. */}
        <dl className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-card)] border bg-[var(--border)] sm:grid-cols-3">
          {GROUPS.map((group) => {
            const count = PLATFORMS.filter((p) => p.status === group.status).length;
            return (
              <div key={group.status} className="bg-[var(--surface-raised)] p-5">
                <dt className="text-sm font-medium">{STATUS_LABEL[group.status]}</dt>
                <dd className="mt-1.5 font-mono text-2xl font-semibold text-[var(--brand-text)]">
                  {count}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>

      {GROUPS.map((group, index) => (
        <Section
          key={group.status}
          id={group.status}
          tone={index % 2 === 1 ? 'sunken' : undefined}
        >
          <SectionHeader heading={group.heading} lead={group.lead} align="left" />

          <ul className="mt-10 grid gap-4 md:grid-cols-2">
            {PLATFORMS.filter((platform) => platform.status === group.status).map((platform) => (
              <li
                key={platform.id}
                className="flex flex-col rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-5"
              >
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--surface-sunken)] text-[var(--text)]">
                    <PlatformMark provider={platform.id} className="h-[22px] w-[22px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold">{platform.name}</h3>
                    <p className="mt-0.5 text-sm text-[var(--text-subtle)]">
                      {platform.publishesTo}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[platform.status]}`}
                  >
                    {STATUS_LABEL[platform.status]}
                  </span>
                </div>

                <p className="mt-4 text-sm text-pretty text-[var(--text-muted)]">
                  {platform.notes}
                </p>

                <dl className="mt-auto flex flex-wrap gap-x-6 gap-y-1 pt-4 text-xs text-[var(--text-subtle)]">
                  <div className="flex gap-1.5">
                    <dt>Approval:</dt>
                    <dd className="text-[var(--text-muted)]">{platform.approval}</dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>API access:</dt>
                    <dd className="text-[var(--text-muted)]">{platform.cost}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </Section>
      ))}

      <Section id="questions">
        <SectionHeader
          heading="Common questions"
          lead="Approval timelines are the part of this product nobody else explains, so these answers are as specific as we can make them."
          align="left"
        />
        <FaqList faqs={FAQS} />
      </Section>

      <ClosingCta
        heading="Start on the network that needs no permission"
        lead="Bluesky publishes today. The same request body reaches every other network the moment its approval lands — no migration, no rewrite."
        primary={{ href: '/docs/quickstart', label: 'Read the quickstart' }}
        secondary={{ href: '/docs', label: 'Browse the API' }}
      />
    </>
  );
}
