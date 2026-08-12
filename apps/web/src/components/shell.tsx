'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { cx } from './ui';

/**
 * Application shell (plan §53).
 *
 * Two navigation treatments rather than one that shrinks. A sidebar squeezed onto a phone
 * becomes a hamburger nobody opens, so on small screens the primary destinations move to
 * a bottom bar within thumb reach and the rest go behind "More". That is a different
 * layout, not a narrower one — which is the difference between "works on mobile" and
 * "technically renders on mobile".
 */

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** Shown in the bottom bar on small screens. The rest live under "More". */
  primary?: boolean;
}

const icon = (path: ReactNode) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

const NAV: NavItem[] = [
  {
    href: '/app',
    label: 'Overview',
    primary: true,
    icon: icon(<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>),
  },
  {
    href: '/app/compose',
    label: 'Compose',
    primary: true,
    icon: icon(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>),
  },
  {
    href: '/app/posts',
    label: 'Posts',
    primary: true,
    icon: icon(<><path d="M4 4h16v12H8l-4 4Z" /></>),
  },
  {
    href: '/app/profiles',
    label: 'Profiles',
    primary: true,
    icon: icon(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></>),
  },
  {
    href: '/app/connections',
    label: 'Connections',
    icon: icon(<><path d="M9 15 15 9" /><path d="M10.5 6.5 12 5a4.2 4.2 0 0 1 6 6l-1.5 1.5" /><path d="M13.5 17.5 12 19a4.2 4.2 0 0 1-6-6l1.5-1.5" /></>),
  },
  {
    href: '/app/media',
    label: 'Media',
    icon: icon(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m21 16-5-5L5 20" /></>),
  },
  {
    href: '/app/webhooks',
    label: 'Webhooks',
    icon: icon(<><path d="M18 16a3 3 0 1 1-2.8-3H16" /><path d="M6 16a3 3 0 1 0 2.8-3" /><path d="M12 5a3 3 0 1 1 2.6 3" /></>),
  },
  {
    href: '/app/keys',
    label: 'API keys',
    icon: icon(<><circle cx="7.5" cy="15.5" r="3.5" /><path d="m10 13 8-8 3 3-2 2-2-2-2 2" /></>),
  },
  {
    href: '/app/logs',
    label: 'Logs',
    icon: icon(<><path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h10" /></>),
  },
  {
    href: '/app/playground',
    label: 'Playground',
    icon: icon(<><polygon points="5 3 19 12 5 21 5 3" /></>),
  },
  {
    href: '/app/platforms',
    label: 'Platforms',
    icon: icon(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 9h6v6H9z" /></>),
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  // Any navigation closes the sheet. Without this it stays open behind the new page,
  // which on a phone looks like the tap did nothing.
  useEffect(() => setMoreOpen(false), [pathname]);

    // '/app' is a prefix of every other dashboard route, so it needs an exact match or
  // every page would highlight Overview as well as itself.
  const isActive = (href: string) => (href === '/app' ? pathname === '/app' : pathname.startsWith(href));

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      {/* Desktop sidebar. Hidden entirely below lg rather than transformed. */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r bg-[var(--surface-raised)] lg:flex">
        <div className="flex h-14 items-center gap-2 border-b px-5">
          <Logo />
          <span className="text-sm font-semibold tracking-tight">GainingSocial</span>
        </div>

        <nav className="flex-1 overflow-y-auto p-3" aria-label="Main">
          <ul className="space-y-0.5">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href as never}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={cx(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                    isActive(item.href)
                      ? 'bg-brand-100 font-medium text-brand-600'
                      : 'text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]',
                  )}
                >
                  {item.icon}
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t p-3">
          <EnvironmentBadge />
        </div>
      </aside>

      <div className="flex min-h-dvh flex-col">
        {/* Mobile top bar. Title only — navigation lives at the bottom. */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-[var(--surface-raised)]/90 px-4 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2">
            <Logo />
            <span className="text-sm font-semibold tracking-tight">GainingSocial</span>
          </div>
          <EnvironmentBadge compact />
        </header>

        {/* pb-20 on small screens keeps content clear of the bottom bar. */}
        <main className="flex-1 px-4 pt-5 pb-24 sm:px-6 lg:px-8 lg:pb-10">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </div>

      {/* Mobile bottom navigation, inside thumb reach and above the home indicator. */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t bg-[var(--surface-raised)]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="grid grid-cols-5">
          {NAV.filter((item) => item.primary).map((item) => (
            <li key={item.href}>
              <Link
                href={item.href as never}
                aria-current={isActive(item.href) ? 'page' : undefined}
                className={cx(
                  'flex min-h-14 flex-col items-center justify-center gap-1 text-[11px]',
                  isActive(item.href) ? 'text-brand-600' : 'text-[var(--text-subtle)]',
                )}
              >
                {item.icon}
                {item.label}
              </Link>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => setMoreOpen((open) => !open)}
              aria-expanded={moreOpen}
              className={cx(
                'flex min-h-14 w-full flex-col items-center justify-center gap-1 text-[11px]',
                moreOpen ? 'text-brand-600' : 'text-[var(--text-subtle)]',
              )}
            >
              {icon(<><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>)}
              More
            </button>
          </li>
        </ul>
      </nav>

      {moreOpen ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          />
          <div className="fixed inset-x-0 bottom-0 z-40 rounded-t-2xl border-t bg-[var(--surface-raised)] pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:hidden">
            <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-[var(--border-strong)]" />
            <ul className="p-3">
              {NAV.filter((item) => !item.primary).map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href as never}
                    className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-sm text-[var(--text-muted)]"
                  >
                    {item.icon}
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Logo() {
  return (
    <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-600 text-[13px] font-bold text-[var(--on-brand)]">
      gs
    </span>
  );
}

/**
 * Test/live indicator.
 *
 * Permanently visible, because the single most expensive mistake in this product is
 * believing you are in test mode while publishing to a real audience.
 */
function EnvironmentBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full bg-warn-100 px-2.5 py-1 text-xs font-medium text-warn-600',
        compact ? '' : 'w-full justify-center',
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      Test mode
    </span>
  );
}
