import Link from 'next/link';

import { BrandLockup } from '@/components/brand';
import { jsonLd, organizationSchema } from '@/lib/seo';

/**
 * Marketing layout.
 *
 * Public, indexed, and built for reading rather than working — so it shares nothing with
 * the dashboard shell beyond the design tokens. A single layout branching on the URL
 * would end up serving app chrome to a search visitor.
 *
 * The small-screen menu is a `<details>` element. It needs no JavaScript, which keeps the
 * whole marketing site free of client bundles, and it is open/closable by keyboard for
 * free. The previous version simply hid the navigation below `md` and relied on the
 * footer, which meant a phone visitor could not reach the platforms page without
 * scrolling the entire home page first.
 */

const NAV_LINKS = [
  { href: '/features', label: 'Features' },
  { href: '/platforms', label: 'Platforms' },
  { href: '/docs', label: 'Docs' },
  { href: '/pricing', label: 'Pricing' },
];

const FOOTER_SECTIONS: {
  title: string;
  links: { href: string; label: string; external?: boolean }[];
}[] = [
  {
    title: 'Product',
    links: [
      { href: '/features/publishing', label: 'Publishing' },
      { href: '/features/scheduling', label: 'Scheduling' },
      { href: '/features/reliability', label: 'Reliability' },
      { href: '/platforms', label: 'Supported platforms' },
      { href: '/pricing', label: 'Pricing' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { href: '/docs', label: 'Documentation' },
      { href: '/docs/quickstart', label: 'Quickstart' },
      { href: '/docs/webhooks', label: 'Webhooks' },
      { href: '/docs/errors', label: 'Error codes' },
      { href: 'https://api.gainingsocial.com/openapi.json', label: 'OpenAPI spec', external: true },
    ],
  },
  {
    title: 'Learn',
    links: [
      { href: '/faq', label: 'FAQ' },
      { href: '/docs/media', label: 'Media uploads' },
      { href: '/docs/retries', label: 'Retries and duplicates' },
      { href: '/docs/multi-tenant', label: 'Multi-tenant and white-label' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { href: '/privacy', label: 'Privacy' },
      { href: '/terms', label: 'Terms' },
      { href: '/data-deletion', label: 'Data deletion' },
    ],
  },
];

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* Organization schema is site-wide, so it belongs in the layout rather than being
          repeated — duplicated across pages it just adds bytes. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(organizationSchema())} />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-sm focus:text-[var(--on-brand)]"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b bg-[var(--surface-raised)]/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center">
            <BrandLockup size={36} />
          </Link>

          <nav aria-label="Main" className="ml-4 hidden md:flex md:items-center md:gap-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href as never}
                className="rounded-lg px-3 py-2 text-sm text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {/* Same-origin `/app`, not `https://app.gainingsocial.com`.
                Both hostnames are served by this one Worker, so the bare subdomain root
                resolved to the marketing home page — clicking "Open dashboard" reloaded
                the page you were already on and looked like a dead button.
                The origin matters beyond the path, too: the Supabase session cookie is
                host-only, so crossing to a sibling hostname drops the session and asks a
                signed-in person to sign in again. */}
            <Link
              href="/app"
              className="inline-flex min-h-9 items-center rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-[var(--on-brand)] transition-colors hover:bg-brand-500"
            >
              Open dashboard
            </Link>

            <details className="relative md:hidden [&[open]_.chevron]:rotate-180">
              <summary
                aria-label="Menu"
                className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-lg border [&::-webkit-details-marker]:hidden"
              >
                <svg
                  className="chevron transition-transform"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
              </summary>
              <div className="absolute right-0 z-40 mt-2 w-52 rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-2 shadow-lg">
                {NAV_LINKS.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href as never}
                    className="flex min-h-11 items-center rounded-lg px-3 text-sm text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </details>
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        {children}
      </main>

      <footer className="border-t bg-[var(--surface-raised)]">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
            <div className="lg:col-span-1">
              <Link href="/" className="flex items-center">
                <BrandLockup size={32} />
              </Link>
              <p className="mt-4 max-w-xs text-sm text-pretty text-[var(--text-subtle)]">
                One REST API for publishing to every major social network — built for software
                and AI agents.
              </p>
            </div>

            {FOOTER_SECTIONS.map((section) => (
              <div key={section.title}>
                <p className="text-sm font-semibold">{section.title}</p>
                <ul className="mt-3 space-y-2.5">
                  {section.links.map((link) => (
                    <li key={link.href}>
                      {link.external ? (
                        <a
                          href={link.href}
                          className="text-sm text-[var(--text-subtle)] transition-colors hover:text-[var(--text)]"
                        >
                          {link.label}
                        </a>
                      ) : (
                        <Link
                          href={link.href as never}
                          className="text-sm text-[var(--text-subtle)] transition-colors hover:text-[var(--text)]"
                        >
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <p className="mt-12 border-t pt-6 text-sm text-[var(--text-subtle)]">
            © {new Date().getFullYear()} GainingSocial. Social publishing infrastructure for
            software and AI agents.
          </p>
        </div>
      </footer>
    </div>
  );
}
