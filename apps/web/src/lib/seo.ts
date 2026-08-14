import type { Metadata } from 'next';

/**
 * SEO helpers.
 *
 * Structured data is what turns a blue link into a result with an FAQ accordion, a
 * breadcrumb trail or a rating. Google will not infer any of it from the prose — it has
 * to be declared, and declared in a shape that validates.
 *
 * These builders exist so every page gets the same shape. Hand-writing JSON-LD per page
 * is how one page ends up with a `FAQPage` whose `acceptedAnswer` is a string instead of
 * an `Answer` object, which silently disqualifies it from rich results with no error
 * anywhere.
 */

export const SITE_URL = 'https://gainingsocial.com';
export const SITE_NAME = 'GainingSocial';

export interface PageSeoInput {
  title: string;
  description: string;
  /** Path only, e.g. `/features/scheduling`. Used for the canonical URL. */
  path: string;
  /** Keeps a page out of the index while still following its links. */
  noindex?: boolean;
}

/**
 * Per-page metadata.
 *
 * The canonical URL matters more than it looks. Without it, `?utm_source=…` links,
 * trailing-slash variants and the www/apex pair all read as separate pages competing
 * with each other for the same ranking.
 */
export function pageSeo(input: PageSeoInput): Metadata {
  const url = `${SITE_URL}${input.path}`;

  return {
    title: input.title,
    description: input.description,
    alternates: { canonical: input.path },
    openGraph: {
      title: input.title,
      description: input.description,
      url,
      type: 'website',
      siteName: SITE_NAME,
    },
    twitter: {
      card: 'summary_large_image',
      title: input.title,
      description: input.description,
    },
    ...(input.noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

/** Renders a JSON-LD block. Next allows this specific case for structured data. */
export function jsonLd(data: Record<string, unknown>): { __html: string } {
  return { __html: JSON.stringify(data) };
}

export interface Faq {
  question: string;
  answer: string;
}

/**
 * `FAQPage` structured data.
 *
 * Answers must be plain text. Google rejects markup inside `text`, and a rejected block
 * fails silently — the page still renders, it just never shows the accordion.
 */
export function faqSchema(faqs: readonly Faq[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })),
  };
}

/**
 * `BreadcrumbList`.
 *
 * Replaces the raw URL in the search result with a readable trail, which measurably
 * improves click-through on deep pages.
 */
export function breadcrumbSchema(
  trail: readonly { name: string; path: string }[],
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  };
}

/** `SoftwareApplication` — the product itself, for the home page. */
export function productSchema(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any',
    url: SITE_URL,
    description:
      'A single REST API for publishing to every major social network, with duplicate ' +
      'prevention, per-platform validation and delivery webhooks.',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: 'Free while in development.',
    },
  };
}

/**
 * `Organization` — publisher identity, used site-wide.
 *
 * `logo` is what Google reads for the knowledge panel and for the brand icon beside a
 * result; without it the crawler picks some image off the page and usually picks wrong.
 * It must be an absolute URL and at least 112x112 to qualify, which `/logo.png` (160px) is.
 */
export function organizationSchema(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: SITE_URL,
    logo: {
      '@type': 'ImageObject',
      url: `${SITE_URL}/logo.png`,
      width: 160,
      height: 160,
    },
    description: 'Social publishing infrastructure for software and AI agents.',
  };
}

/**
 * `HowTo`, for pages that explain a sequence.
 *
 * Worth declaring because a "how to publish to X via API" query is exactly the kind of
 * intent this product should own, and a HowTo result takes far more vertical space than
 * a plain link.
 */
export function howToSchema(input: {
  name: string;
  description: string;
  steps: readonly { name: string; text: string }[];
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: input.name,
    description: input.description,
    step: input.steps.map((step, index) => ({
      '@type': 'HowToStep',
      position: index + 1,
      name: step.name,
      text: step.text,
    })),
  };
}
