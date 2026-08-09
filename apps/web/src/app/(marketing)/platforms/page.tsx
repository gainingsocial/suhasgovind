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
 */

interface Platform {
  name: string;
  status: 'available' | 'awaiting-approval' | 'planned';
  approval: string;
  notes: string;
  cost: string;
}

const PLATFORMS: readonly Platform[] = [
  {
    name: 'Bluesky',
    status: 'available',
    approval: 'None',
    cost: 'Free',
    notes:
      'No developer portal and no review queue. You create an app password in Bluesky’s settings and start publishing. That is why it is the first network supported.',
  },
  {
    name: 'Telegram',
    status: 'awaiting-approval',
    approval: 'None — bot token only',
    cost: 'Free',
    notes:
      'A bot token from @BotFather is the whole setup. Publishes to channels and groups rather than a public feed.',
  },
  {
    name: 'LinkedIn',
    status: 'awaiting-approval',
    approval: 'Two tiers, several weeks',
    cost: 'Free',
    notes:
      'Requires a registered legal organisation and a business email; personal addresses do not pass vetting. Development access comes first, then a Standard tier review with a screen recording.',
  },
  {
    name: 'Facebook Pages',
    status: 'awaiting-approval',
    approval: '4–6 weeks',
    cost: 'Free',
    notes:
      'Needs Meta Business Verification and app review with a screencast. One Meta app covers Facebook, Instagram and Threads.',
  },
  {
    name: 'Instagram',
    status: 'awaiting-approval',
    approval: '4–6 weeks',
    cost: 'Free',
    notes:
      'Requires a Business or Creator account linked to a Facebook Page. Personal accounts cannot publish through any API.',
  },
  {
    name: 'Threads',
    status: 'awaiting-approval',
    approval: '4–6 weeks',
    cost: 'Free',
    notes: 'Shares the Meta app and its review with Facebook and Instagram.',
  },
  {
    name: 'TikTok',
    status: 'awaiting-approval',
    approval: '2–4 week audit',
    cost: 'Free',
    notes:
      'The Content Posting API needs an audit separate from developer signup. Until it passes, TikTok forces every post made through the API to be visible only to its creator.',
  },
  {
    name: 'YouTube',
    status: 'awaiting-approval',
    approval: 'Compliance audit',
    cost: 'Free',
    notes: 'Uploads from unaudited projects are restricted to private visibility until the audit passes.',
  },
  {
    name: 'Pinterest',
    status: 'planned',
    approval: 'Standard app review',
    cost: 'Free',
    notes: 'Publishes Pins to boards.',
  },
  {
    name: 'X',
    status: 'planned',
    approval: 'Immediate, on a paid tier',
    cost: 'Paid',
    notes: 'The only major network that charges for the ability to publish.',
  },
  {
    name: 'Discord',
    status: 'planned',
    approval: 'None — bot token',
    cost: 'Free',
    notes: 'Posts to channels through a bot. The lightest setup of any platform here.',
  },
  {
    name: 'Google Business Profile',
    status: 'planned',
    approval: 'Google Cloud project and access request',
    cost: 'Free',
    notes: 'Publishes updates to a business listing rather than a social feed.',
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
];

const TONE = {
  available: 'bg-ok-100 text-ok-600',
  'awaiting-approval': 'bg-warn-100 text-warn-600',
  planned: 'bg-[var(--surface-sunken)] text-[var(--text-muted)]',
} as const;

const LABEL = {
  available: 'Available now',
  'awaiting-approval': 'Built, awaiting approval',
  planned: 'Planned',
} as const;

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

      <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Supported social networks
        </h1>
        <p className="mt-4 max-w-2xl text-base text-pretty text-[var(--text-muted)]">
          Every network below is implemented. What differs is whether the platform has granted
          access yet — most require a business application that takes weeks, which is why they are
          listed separately rather than promised vaguely.
        </p>

        <ul className="mt-10 space-y-3">
          {PLATFORMS.map((platform) => (
            <li
              key={platform.name}
              className="rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-4 sm:p-5"
            >
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-base font-semibold">{platform.name}</h2>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[platform.status]}`}
                >
                  {LABEL[platform.status]}
                </span>
                <span className="ml-auto text-xs text-[var(--text-subtle)]">{platform.cost}</span>
              </div>
              <p className="mt-2 text-sm text-pretty text-[var(--text-muted)]">{platform.notes}</p>
              <p className="mt-2 text-xs text-[var(--text-subtle)]">
                Approval required: {platform.approval}
              </p>
            </li>
          ))}
        </ul>

        <h2 className="mt-14 text-2xl font-semibold tracking-tight">Common questions</h2>
        <dl className="mt-6 divide-y">
          {FAQS.map((faq) => (
            <div key={faq.question} className="py-5">
              <dt className="text-base font-medium">{faq.question}</dt>
              <dd className="mt-2 text-sm text-pretty text-[var(--text-muted)]">{faq.answer}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}
