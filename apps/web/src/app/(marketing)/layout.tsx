import Link from 'next/link';

import { jsonLd, organizationSchema } from '@/lib/seo';

/**
 * Marketing layout.
 *
 * Public, indexed, and built for reading rather than working — so it shares nothing with
 * the dashboard shell beyond the design tokens. A single layout branching on the URL
 * would end up serving app chrome to a search visitor.
 */

const PRODUCT_LINKS = [
  { href: '/features/publishing', label: 'Publishing' },
  { href: '/features/scheduling', label: 'Scheduling' },
  { href: '/features/reliability', label: 'Reliability' },
  { href: '/platforms', label: 'Platforms' },
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
          <Link href="/" className="flex shrink-0 items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-[var(--on-brand)]">
              gs
            </span>
            <span className="text-[15px] font-semibold tracking-tight">GainingSocial</span>
          </Link>

          {/* Hidden below md rather than crammed into a hamburger. The footer carries the
              same links, which on a marketing site is where people look on a phone. */}
          <nav aria-label="Product" className="ml-4 hidden md:flex md:items-center md:gap-1">
            {PRODUCT_LINKS.map((link) => (
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
            <Link
              href="/docs"
              className="hidden rounded-lg px-3 py-2 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text)] sm:inline-flex"
            >
              Docs
            </Link>
            <a
              href="https://app.gainingsocial.com"
              className="inline-flex min-h-9 items-center rounded-lg bg-brand-600 px-3.5 text-sm font-medium text-[var(--on-brand)] transition-colors hover:bg-brand-500"
            >
              Open dashboard
            </a>
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        {children}
      </main>

      <footer className="border-t bg-[var(--surface-raised)]">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-sm font-semibold">Product</p>
              <ul className="mt-3 space-y-2">
                {PRODUCT_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href as never}
                      className="text-sm text-[var(--text-subtle)] transition-colors hover:text-[var(--text)]"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="text-sm font-semibold">Developers</p>
              <ul className="mt-3 space-y-2">
                <li>
                  <Link href="/docs" className="text-sm text-[var(--text-subtle)] hover:text-[var(--text)]">
                    Documentation
                  </Link>
                </li>
                <li>
                  <Link href="/docs/quickstart" className="text-sm text-[var(--text-subtle)] hover:text-[var(--text)]">
                    Quickstart
                  </Link>
                </li>
                <li>
                  <a
                    href="https://api.gainingsocial.com/openapi.json"
                    className="text-sm text-[var(--text-subtle)] hover:text-[var(--text)]"
                  >
                    OpenAPI spec
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <p className="text-sm font-semibold">Learn</p>
              <ul className="mt-3 space-y-2">
                <li>
                  <Link href="/faq" className="text-sm text-[var(--text-subtle)] hover:text-[var(--text)]">
                    FAQ
                  </Link>
                </li>
                <li>
                  <Link href="/platforms" className="text-sm text-[var(--text-subtle)] hover:text-[var(--text)]">
                    Supported platforms
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <p className="text-sm font-semibold">Legal</p>
              <ul className="mt-3 space-y-2">
                <li>
                  <Link href="/privacy" className="text-sm text-[var(--text-subtle)] hover:text-[var(--text)]">
                    Privacy
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="text-sm text-[var(--text-subtle)] hover:text-[var(--text)]">
                    Terms
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <p className="mt-10 border-t pt-6 text-sm text-[var(--text-subtle)]">
            © {new Date().getFullYear()} GainingSocial. Social publishing infrastructure for
            software and AI agents.
          </p>
        </div>
      </footer>
    </div>
  );
}
