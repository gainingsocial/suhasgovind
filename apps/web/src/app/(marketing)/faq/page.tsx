import Link from 'next/link';

import { breadcrumbSchema, faqSchema, jsonLd, pageSeo, type Faq } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Frequently asked questions',
  description:
    'Common questions about publishing to social networks through an API: supported platforms, ' +
    'duplicate prevention, scheduling, pricing, and what approval each network requires.',
  path: '/faq',
});

/**
 * Consolidated FAQ.
 *
 * Grouped by topic so a reader can scan, but emitted as a single FAQPage block so the
 * whole page is eligible for an expandable result rather than four sections competing
 * with each other.
 */

const GROUPS: readonly { heading: string; faqs: readonly Faq[] }[] = [
  {
    heading: 'Getting started',
    faqs: [
      {
        question: 'What is GainingSocial?',
        answer:
          'A single REST API for publishing to social networks. Instead of integrating separately with LinkedIn, Instagram, TikTok and Bluesky — each with its own authentication, limits and error formats — you make one call and the service translates it for every destination you selected.',
      },
      {
        question: 'Who is it for?',
        answer:
          'Software that needs to publish on behalf of other people: scheduling tools, agency platforms, e-commerce systems posting product updates, and AI agents that create and publish content. It is infrastructure rather than an end-user scheduling app.',
      },
      {
        question: 'What do I need to start?',
        answer:
          'An API key and one connected social account. Bluesky needs no approval from anyone, so you can publish the same day. Every other network requires that platform’s developer approval first.',
      },
    ],
  },
  {
    heading: 'Publishing',
    faqs: [
      {
        question: 'Can I send different content to each network?',
        answer:
          'Yes. Write the shared version once, then override the text, media or link for any individual destination. Overrides replace the shared value rather than merging with it.',
      },
      {
        question: 'What happens if one network fails and the others succeed?',
        answer:
          'The post is marked partly published. Each destination reports its own status and its own error, so a failure on one network never hides behind a single overall verdict, and the destinations that worked are never rolled back.',
      },
      {
        question: 'How do I know a post actually went live?',
        answer:
          'Either poll the post, which reports each destination independently, or register a webhook and receive a signed notification the moment a destination publishes, fails or is retried.',
      },
    ],
  },
  {
    heading: 'Reliability',
    faqs: [
      {
        question: 'How do you prevent the same post going out twice?',
        answer:
          'Four independent layers: an idempotency key on every request, an exclusive lock per destination while it publishes, a content fingerprint that catches accidental repeats, and — when an outcome is genuinely ambiguous — checking the account for the post before retrying rather than publishing again blindly.',
      },
      {
        question: 'What if a network accepts my post but the confirmation is lost?',
        answer:
          'That case is treated as unknown rather than failed, and no retry happens. The system searches the connected account for the post. If it is there, it is adopted and nothing is republished. If it is provably absent, retrying is safe. If neither can be established, it waits for a human.',
      },
      {
        question: 'What happens during a platform outage?',
        answer:
          'Failed destinations are retried with increasing delays and randomised timing, so a recovering platform is not hit by every pending post at once. A destination that has permanently failed is not retried at all, because the same request would fail in the same way.',
      },
    ],
  },
  {
    heading: 'Platforms and pricing',
    faqs: [
      {
        question: 'Which networks can I publish to today?',
        answer:
          'Bluesky. Every other network is implemented but waiting on that platform’s developer approval, which takes between two and eight weeks depending on the platform.',
      },
      {
        question: 'How much does it cost?',
        answer:
          'It is free while in development. Of the social networks themselves, only X charges for the ability to publish through its API; the rest provide free access to approved applications.',
      },
      {
        question: 'Why does platform approval take so long?',
        answer:
          'Most platforms require a registered business, a privacy policy, a data deletion process and a recorded demonstration of the integration before granting publishing access. TikTok and YouTube additionally require a compliance audit, and restrict posts to private visibility until it passes.',
      },
    ],
  },
];

const ALL = GROUPS.flatMap((group) => group.faqs);

export default function FaqPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'FAQ', path: '/faq' },
          ]),
        )}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(faqSchema(ALL))} />

      <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Frequently asked questions
        </h1>
        <p className="mt-4 text-base text-pretty text-[var(--text-muted)]">
          How publishing works, what happens when it does not, and which networks are available.
        </p>

        {GROUPS.map((group) => (
          <section key={group.heading} className="mt-12">
            <h2 className="text-xl font-semibold tracking-tight">{group.heading}</h2>
            <dl className="mt-4 divide-y">
              {group.faqs.map((faq) => (
                <div key={faq.question} className="py-5">
                  <dt className="text-base font-medium">{faq.question}</dt>
                  <dd className="mt-2 text-sm text-pretty text-[var(--text-muted)]">
                    {faq.answer}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}

        <p className="mt-12 border-t pt-6 text-sm text-[var(--text-subtle)]">
          Still unsure? The{' '}
          <Link href="/docs" className="text-[var(--brand-text)] hover:underline">
            documentation
          </Link>{' '}
          covers the API in full, and{' '}
          <Link href="/platforms" className="text-[var(--brand-text)] hover:underline">
            supported platforms
          </Link>{' '}
          lists what each network requires.
        </p>
      </div>
    </>
  );
}
