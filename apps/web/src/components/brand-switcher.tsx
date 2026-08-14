import Link from 'next/link';

import type { Brand } from '@/lib/brands';
import { cx } from './ui';

/**
 * Brand switcher.
 *
 * Links rather than a `<select>` with an onChange handler, so the whole screen stays a
 * server component and each brand is a real URL somebody can bookmark or share. A dropdown
 * that needs JavaScript to change what a page shows is the wrong trade for a control with
 * two or three options.
 *
 * Hidden entirely at one brand. A switcher offering a single choice is furniture that
 * teaches a new user their account is more complicated than it is.
 */
export function BrandSwitcher({
  brands,
  selected,
  basePath,
}: {
  brands: Brand[];
  selected: Brand | null;
  basePath: string;
}) {
  if (brands.length < 2 || !selected) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Brand">
      {brands.map((brand) => {
        const active = brand.id === selected.id;

        return (
          <Link
            key={brand.id}
            href={`${basePath}?brand=${brand.id}` as never}
            aria-current={active ? 'true' : undefined}
            className={cx(
              'inline-flex min-h-8 items-center rounded-full px-3 text-xs font-medium transition-colors',
              active
                ? 'bg-brand-100 text-[var(--brand-text)]'
                : 'border text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]',
            )}
          >
            {brand.name}
            {brand.disabled_at ? (
              <span className="ml-1.5 text-[var(--text-subtle)]">(disabled)</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
