import Link from 'next/link';

import { breadcrumbSchema, faqSchema, howToSchema, jsonLd, type Faq } from '@/lib/seo';

/**
 * Shared shape for a documentation guide.
 *
 * The same skeleton as `FeaturePage` and for the same reason — one place where the
 * structured data is emitted, so a guide cannot silently ship without its `FAQPage`
 * block. Two differences justify a separate component rather than a prop on that one:
 *
 *   The breadcrumb is three deep (Home / Documentation / this guide), which is what makes
 *   a deep docs page show a readable trail in search results instead of a bare URL.
 *
 *   Sections carry code. A feature page argues; a guide shows the request. Prose-only
 *   sections would push every example into a single trailing block, which is not how
 *   anyone reads documentation.
 */

export interface GuideSection {
  heading: string;
  paragraphs: readonly string[];
  /** Rendered under the prose. Horizontal scroll stays inside the block. */
  code?: string;
}

export interface GuidePageProps {
  /** Slug and title of this guide; the Home and Documentation crumbs are implied. */
  breadcrumb: { name: string; path: string };
  heading: string;
  lead: string;
  body: readonly GuideSection[];
  /** Emitted as HowTo structured data as well as rendered. */
  steps?: readonly { name: string; text: string }[];
  faqs: readonly Faq[];
  related?: readonly { href: string; label: string }[];
}

export function GuidePage({ breadcrumb, heading, lead, body, steps, faqs, related }: GuidePageProps) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([
            { name: 'Home', path: '/' },
            { name: 'Documentation', path: '/docs' },
            breadcrumb,
          ]),
        )}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(faqSchema(faqs))} />
      {steps ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={jsonLd(howToSchema({ name: heading, description: lead, steps }))}
        />
      ) : null}

      <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        {/* Visible breadcrumb as well as the structured one: the markup earns the trail in
            search results, the visible version orients the reader who arrived from it. */}
        <nav aria-label="Breadcrumb" className="text-sm text-[var(--text-subtle)]">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <Link href="/" className="hover:text-[var(--text)]">
                Home
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href="/docs" className="hover:text-[var(--text)]">
                Documentation
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li className="text-[var(--text-muted)]">{breadcrumb.name}</li>
          </ol>
        </nav>

        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {heading}
        </h1>
        <p className="mt-4 text-base text-pretty text-[var(--text-muted)] sm:text-lg">{lead}</p>

        {body.map((section) => (
          <section key={section.heading} className="mt-12">
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{section.heading}</h2>
            <div className="mt-3 space-y-4 text-sm text-pretty text-[var(--text-muted)]">
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph.slice(0, 40)}>{paragraph}</p>
              ))}
            </div>
            {section.code ? (
              // Scrolling on the block itself, so a long line never makes the whole page
              // scroll sideways on a phone.
              <pre className="mt-4 overflow-x-auto rounded-[var(--radius-card)] border bg-[var(--surface-sunken)] p-4">
                <code className="font-mono text-xs whitespace-pre">{section.code}</code>
              </pre>
            ) : null}
          </section>
        ))}

        {steps ? (
          <section className="mt-12">
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">At a glance</h2>
            <ol className="mt-4 space-y-3">
              {steps.map((step, index) => (
                <li
                  key={step.name}
                  className="flex gap-3 rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-4"
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-600">
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{step.name}</span>
                    <span className="mt-1 block text-sm text-pretty text-[var(--text-muted)]">
                      {step.text}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <section className="mt-12">
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
            Frequently asked questions
          </h2>
          <dl className="mt-4 divide-y">
            {faqs.map((faq) => (
              <div key={faq.question} className="py-5">
                <dt className="text-base font-medium">{faq.question}</dt>
                <dd className="mt-2 text-sm text-pretty text-[var(--text-muted)]">{faq.answer}</dd>
              </div>
            ))}
          </dl>
        </section>

        {related && related.length > 0 ? (
          // Internal linking spreads authority to deeper pages and gives a crawler a route
          // to them that does not depend on the sitemap alone.
          <nav aria-label="Related pages" className="mt-12 border-t pt-6">
            <h2 className="text-sm font-semibold">Keep reading</h2>
            <ul className="mt-3 space-y-2">
              {related.map((link) => (
                <li key={link.href}>
                  <Link href={link.href as never} className="text-sm text-brand-600 hover:underline">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </article>
    </>
  );
}
