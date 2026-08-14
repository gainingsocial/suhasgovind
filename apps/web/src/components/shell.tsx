'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { BrandMark } from './brand';
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
  /**
   * Which band of the sidebar this belongs to.
   *
   * The creator plan (§5.1) reorganizes the dashboard around a person's day rather than
   * around the API's resources. `daily` is what somebody opens every morning; `setup` is
   * configuration they touch a few times; `developer` is the original surface, intact but
   * no longer competing with the daily work for attention.
   */
  group: 'daily' | 'setup' | 'developer';
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

/**
 * The destinations, in the order a person meets them (creator plan §5.1).
 *
 * The previous ordering was the API's resource list — profiles, connections, keys,
 * webhooks, logs — which is the right vocabulary for the API and the wrong one for the
 * person publishing. Rule C2: nothing in the studio is named after a database table, so
 * "Profiles" is Brands and "Connections" is Accounts. The API keeps its own names; only the
 * label changes, and the routes are untouched so every existing link still resolves.
 */
const NAV: NavItem[] = [
  // Daily — what somebody opens without deciding to.
  {
    href: '/app',
    label: 'Today',
    group: 'daily',
    primary: true,
    icon: icon(<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>),
  },
  {
    href: '/app/compose',
    label: 'Studio',
    group: 'daily',
    primary: true,
    icon: icon(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>),
  },
  {
    href: '/app/posts',
    label: 'Posts',
    group: 'daily',
    icon: icon(<><path d="M4 4h16v12H8l-4 4Z" /></>),
  },
  {
    href: '/app/inbox',
    label: 'Inbox',
    group: 'daily',
    primary: true,
    icon: icon(<><path d="M4 13h4l2 3h4l2-3h4" /><path d="M4 13 6 5h12l2 8v6H4Z" /></>),
  },
  {
    href: '/app/insights',
    label: 'Insights',
    group: 'daily',
    icon: icon(<><path d="M4 19V9" /><path d="M10 19V5" /><path d="M16 19v-7" /><path d="M22 19H2" /></>),
  },
  {
    href: '/app/autopilot',
    label: 'Autopilot',
    group: 'daily',
    primary: true,
    icon: icon(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3" /><path d="M12 19v3" /><path d="m4.9 4.9 2.2 2.2" /><path d="m16.9 16.9 2.2 2.2" /><path d="M2 12h3" /><path d="M19 12h3" /></>),
  },

  // Setup — touched a handful of times, then rarely.
  {
    href: '/app/connections',
    label: 'Accounts',
    group: 'setup',
    icon: icon(<><path d="M9 15 15 9" /><path d="M10.5 6.5 12 5a4.2 4.2 0 0 1 6 6l-1.5 1.5" /><path d="M13.5 17.5 12 19a4.2 4.2 0 0 1-6-6l1.5-1.5" /></>),
  },
  {
    href: '/app/profiles',
    label: 'Brands',
    group: 'setup',
    icon: icon(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></>),
  },
  {
    href: '/app/media',
    label: 'Media',
    group: 'setup',
    icon: icon(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m21 16-5-5L5 20" /></>),
  },
  {
    href: '/app/platforms',
    label: 'Platforms',
    group: 'setup',
    icon: icon(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 9h6v6H9z" /></>),
  },
  {
    href: '/app/usage',
    label: 'Usage',
    group: 'setup',
    icon: icon(<><path d="M12 2a10 10 0 1 0 10 10h-10Z" /><path d="M12 2v10h10A10 10 0 0 0 12 2Z" /></>),
  },

  // Developer — unchanged and undiminished, just no longer in the way (creator plan §4.4).
  {
    href: '/app/playground',
    label: 'Playground',
    group: 'developer',
    icon: icon(<><polygon points="5 3 19 12 5 21 5 3" /></>),
  },
  {
    href: '/app/keys',
    label: 'API keys',
    group: 'developer',
    icon: icon(<><circle cx="7.5" cy="15.5" r="3.5" /><path d="m10 13 8-8 3 3-2 2-2-2-2 2" /></>),
  },
  {
    href: '/app/webhooks',
    label: 'Webhooks',
    group: 'developer',
    icon: icon(<><path d="M18 16a3 3 0 1 1-2.8-3H16" /><path d="M6 16a3 3 0 1 0 2.8-3" /><path d="M12 5a3 3 0 1 1 2.6 3" /></>),
  },
  {
    href: '/app/logs',
    label: 'Logs',
    group: 'developer',
    icon: icon(<><path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h10" /></>),
  },
];

/** Band headings. `daily` has none — the top of a list needs no label. */
const GROUP_LABEL: Record<NavItem['group'], string | null> = {
  daily: null,
  setup: 'Setup',
  developer: 'Developer',
};

const GROUPS: NavItem['group'][] = ['daily', 'setup', 'developer'];

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
          {GROUPS.map((group) => {
            const items = NAV.filter((item) => item.group === group);
            if (items.length === 0) return null;

            const heading = GROUP_LABEL[group];

            return (
              <div key={group} className="mb-4 last:mb-0">
                {heading ? (
                  <h2 className="px-3 pb-1.5 text-[11px] font-semibold tracking-wide text-[var(--text-subtle)] uppercase">
                    {heading}
                  </h2>
                ) : null}

                <ul className="space-y-0.5">
                  {items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href as never}
                        aria-current={isActive(item.href) ? 'page' : undefined}
                        className={cx(
                          'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                          isActive(item.href)
                            ? 'bg-brand-100 font-medium text-[var(--brand-text)]'
                            : 'text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]',
                        )}
                      >
                        {item.icon}
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
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
                  isActive(item.href) ? 'text-[var(--brand-text)]' : 'text-[var(--text-subtle)]',
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
                moreOpen ? 'text-[var(--brand-text)]' : 'text-[var(--text-subtle)]',
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
          {/*
            Scrollable and capped. With three bands the sheet can exceed a short phone's
            viewport, and a list whose last item cannot be reached is worse than a sidebar.
          */}
          <div className="fixed inset-x-0 bottom-0 z-40 max-h-[75dvh] overflow-y-auto rounded-t-2xl border-t bg-[var(--surface-raised)] pb-[calc(env(safe-area-inset-bottom)+5rem)] lg:hidden">
            <div className="sticky top-0 bg-[var(--surface-raised)] pt-3 pb-1">
              <div className="mx-auto h-1 w-10 rounded-full bg-[var(--border-strong)]" />
            </div>

            {GROUPS.map((group) => {
              const items = NAV.filter((item) => item.group === group && !item.primary);
              if (items.length === 0) return null;

              const heading = GROUP_LABEL[group];

              return (
                <div key={group} className="px-3 pb-2">
                  {heading ? (
                    <h2 className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-[var(--text-subtle)] uppercase">
                      {heading}
                    </h2>
                  ) : null}

                  <ul>
                    {items.map((item) => (
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
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * The sidebar mark is the same asset as the marketing header's, one size down — the studio
 * and the public site are one product and should not carry two different logos.
 */
function Logo() {
  return <BrandMark size={28} />;
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
