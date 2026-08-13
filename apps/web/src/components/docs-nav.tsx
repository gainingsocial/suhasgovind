'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cx } from './ui';

/**
 * Documentation sidebar.
 *
 * The docs pages were a `max-w-3xl` column inside a `max-w-6xl` page, which left roughly a
 * third of a desktop viewport permanently blank and made every page look like it had
 * failed to load something. The space is now navigation, which is what a documentation
 * site does with it — and it means the reference is reachable from any page rather than
 * only by going back to the index.
 *
 * A client component solely for `usePathname`. The rest of the marketing site ships no
 * JavaScript at all, and this is a deliberate exception: a sidebar that does not show
 * where you are is worse than no sidebar.
 */

const GROUPS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: 'Getting started',
    links: [
      { href: '/docs', label: 'Overview' },
      { href: '/docs/quickstart', label: 'Quickstart' },
    ],
  },
  {
    title: 'Guides',
    links: [
      { href: '/docs/retries', label: 'Retries and duplicates' },
      { href: '/docs/webhooks', label: 'Webhooks' },
      { href: '/docs/media', label: 'Media uploads' },
      { href: '/docs/multi-tenant', label: 'Multi-tenant' },
    ],
  },
  {
    title: 'Reference',
    links: [{ href: '/docs/errors', label: 'Error codes' }],
  },
];

export function DocsNav() {
  const pathname = usePathname();

  // `/docs` prefixes every other page here, so it needs an exact match. Every error code
  // page should light up the reference entry, which is what the prefix test gives.
  const isActive = (href: string) =>
    href === '/docs' ? pathname === '/docs' : pathname.startsWith(href);

  return (
    <nav
      aria-label="Documentation"
      className="hidden lg:sticky lg:top-24 lg:block lg:self-start lg:pt-14"
    >
      <ul className="space-y-7">
        {GROUPS.map((group) => (
          <li key={group.title}>
            <p className="text-xs font-semibold tracking-[0.08em] text-[var(--text-subtle)] uppercase">
              {group.title}
            </p>
            <ul className="mt-3 space-y-0.5 border-l">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href as never}
                    aria-current={isActive(link.href) ? 'page' : undefined}
                    className={cx(
                      '-ml-px block border-l py-1.5 pl-4 text-sm transition-colors',
                      isActive(link.href)
                        ? 'border-brand-600 font-medium text-[var(--text)]'
                        : 'border-transparent text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]',
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <div className="mt-9 rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-4">
        <p className="text-sm font-medium">OpenAPI specification</p>
        <p className="mt-1.5 text-sm text-[var(--text-subtle)]">
          The machine-readable contract, generated from the same schemas the API validates
          against.
        </p>
        <a
          href="https://api.gainingsocial.com/openapi.json"
          className="mt-3 inline-block text-sm underline underline-offset-4"
        >
          openapi.json →
        </a>
      </div>
    </nav>
  );
}
