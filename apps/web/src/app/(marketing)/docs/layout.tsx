import { DocsNav } from '@/components/docs-nav';

/**
 * Documentation layout.
 *
 * A two-column grid on desktop and a single column below `lg`, where the sidebar is hidden
 * rather than collapsed into a control — the marketing header already carries a menu, and
 * a second disclosure on the same screen is one too many.
 *
 * The horizontal padding lives here so the pages inside only decide their own vertical
 * rhythm. Each page still caps its measure, because a documentation column that stretches
 * to the full content width is unreadable at 1440px however much space is available.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-14">
        <DocsNav />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
