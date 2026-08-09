import Link from 'next/link';

import { breadcrumbSchema, faqSchema, howToSchema, jsonLd, type Faq } from '@/lib/seo';

/**
 * Shared shape for a feature page.
 *
 * Every feature page has the same skeleton — heading, lead, diagram, real prose, a
 * how-it-works sequence, FAQs — because that shape is what ranks and what a reader can
 * skim. Rebuilding it per page is how one page ends up with a `FAQPage` block and its
 * neighbour silently does not.
 */

export interface FeaturePageProps {
  breadcrumb: { name: string; path: string };
  heading: string;
  lead: string;
  diagram?: React.ReactNode;
  /** Real paragraphs. A feature page of bullet points has nothing to index. */
  body: readonly { heading: string; paragraphs: readonly string[] }[];
  /** Emitted as HowTo structured data as well as rendered. */
  steps?: readonly { name: string; text: string }[];
  faqs: readonly Faq[];
  related?: readonly { href: string; label: string }[];
}

export function FeaturePage({
  breadcrumb,
  heading,
  lead,
  diagram,
  body,
  steps,
  faqs,
  related,
}: FeaturePageProps) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={jsonLd(
          breadcrumbSchema([{ name: 'Home', path: '/' }, breadcrumb]),
        )}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(faqSchema(faqs))} />
      {steps ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={jsonLd(
            howToSchema({ name: heading, description: lead, steps }),
          )}
        />
      ) : null}

      <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        {/* Visible breadcrumb as well as the structured one. The markup earns the trail in
            search results; the visible version helps the reader who arrived on a deep page
            from that result. */}
        <nav aria-label="Breadcrumb" className="text-sm text-[var(--text-subtle)]">
          <ol className="flex items-center gap-2">
            <li>
              <Link href="/" className="hover:text-[var(--text)]">
                Home
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

        {diagram ? <div className="mt-10">{diagram}</div> : null}

        {body.map((section) => (
          <section key={section.heading} className="mt-12">
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{section.heading}</h2>
            <div className="mt-3 space-y-4 text-sm text-pretty text-[var(--text-muted)]">
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph.slice(0, 40)}>{paragraph}</p>
              ))}
            </div>
          </section>
        ))}

        {steps ? (
          <section className="mt-12">
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">How it works</h2>
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
                  <Link
                    href={link.href as never}
                    className="text-sm text-brand-600 hover:underline"
                  >
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
