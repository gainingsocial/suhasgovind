import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/seo';

/**
 * robots.txt.
 *
 * `/app/` is disallowed because it is the dashboard: behind a login, nothing to rank, and
 * dozens of thin pages that would dilute the domain's authority if indexed.
 *
 * The sitemap reference is what tells a crawler where to start rather than relying on it
 * discovering every page through links.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/app/', '/api/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
