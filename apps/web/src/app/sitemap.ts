import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/seo';

/**
 * Sitemap.
 *
 * Lists only indexable marketing and docs pages. Dashboard routes are deliberately
 * absent: they are `noindex`, and listing a noindex URL in a sitemap is a contradiction
 * that Search Console reports as an error.
 *
 * `priority` is a weak signal at best, but the relative ordering still communicates which
 * pages matter when a crawler has a limited budget for the site.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const pages: { path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'] }[] = [
    { path: '/', priority: 1, changeFrequency: 'weekly' },
    { path: '/features/publishing', priority: 0.9, changeFrequency: 'monthly' },
    { path: '/features/scheduling', priority: 0.9, changeFrequency: 'monthly' },
    { path: '/features/reliability', priority: 0.9, changeFrequency: 'monthly' },
    { path: '/platforms', priority: 0.8, changeFrequency: 'weekly' },
    { path: '/docs', priority: 0.8, changeFrequency: 'weekly' },
    { path: '/docs/quickstart', priority: 0.8, changeFrequency: 'monthly' },
    // Guides. `/docs/retries` ranks the argument the product is built on, so it sits level
    // with the quickstart rather than below the rest.
    { path: '/docs/retries', priority: 0.8, changeFrequency: 'monthly' },
    { path: '/docs/webhooks', priority: 0.7, changeFrequency: 'monthly' },
    { path: '/docs/media', priority: 0.7, changeFrequency: 'monthly' },
    { path: '/docs/multi-tenant', priority: 0.7, changeFrequency: 'monthly' },
    { path: '/faq', priority: 0.7, changeFrequency: 'monthly' },
    { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' },
    { path: '/terms', priority: 0.3, changeFrequency: 'yearly' },
  ];

  return pages.map((page) => ({
    url: `${SITE_URL}${page.path}`,
    lastModified: now,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
