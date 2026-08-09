import type { Metadata } from 'next';

import { Shell } from '@/components/shell';

/**
 * Dashboard layout.
 *
 * `noindex` on the whole group, and that is a deliberate SEO decision rather than an
 * omission. These pages sit behind a login and have nothing a searcher wants; letting
 * them into the index would dilute the domain's authority across dozens of thin,
 * unreachable pages and leak product surface area to competitors.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* First tab stop. Without it, keyboard users traverse the whole navigation on
          every single page load. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-sm focus:text-[var(--on-brand)]"
      >
        Skip to content
      </a>
      <Shell>
        <div id="main">{children}</div>
      </Shell>
    </>
  );
}
