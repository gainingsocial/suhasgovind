import { cx } from './ui';

/**
 * The GainingSocial mark.
 *
 * One component rather than the same markup pasted into the marketing header, the marketing
 * footer and the app sidebar. Those three were three separate copies of a `gs` lettermark
 * that had already drifted to different sizes, and a logo that differs between the site and
 * the dashboard is the kind of thing nobody files a bug about but everybody notices.
 *
 * ## About the art
 *
 * `/logo.png` is the brand illustration with its light-grey surround knocked out, so what
 * remains is the ring and its contents on transparency. That is deliberate and it is why
 * there is no background colour, border or tile here: the disc *is* the mark, and it reads
 * correctly on both the light and dark surfaces without a chip behind it.
 *
 * The file is 160px for a mark drawn at most at 40px — enough for a 3x display, small
 * enough (~14 KB) to sit in the header of every marketing page for free.
 *
 * ## Sizing
 *
 * `size` drives the `width`/`height` attributes and the style together so they cannot fall
 * out of step. Attributes rather than classes alone because they reserve the space before
 * the image arrives; without them the header text jumps sideways on first paint.
 */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    // A plain <img>, not next/image: the optimizer is off (next.config.ts
    // `images.unoptimized`), so next/image would emit this same tag and attach client
    // runtime for nothing.
    <img
      src="/logo.png"
      /*
       * Decorative, on purpose. Every use of this mark sits inside a link that already
       * carries the word "GainingSocial", so alt text here would make a screen reader
       * announce the brand name twice for one link.
       */
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      /*
       * Above the fold on every page, so it is fetched eagerly and at high priority. The
       * browser default of lazy-loading is right for images further down and wrong for the
       * one in the header — deferring it is a visible pop-in and a measurable LCP cost.
       */
      loading="eager"
      fetchPriority="high"
      decoding="sync"
      className={cx('shrink-0', className)}
    />
  );
}

/**
 * Mark plus wordmark — the full lockup, as it appears in a header or footer.
 *
 * The wordmark is not baked into the image. Keeping it as live text means it stays crisp at
 * any zoom, is selectable, and is what a search engine reads as the site name.
 */
export function BrandLockup({
  size = 32,
  className,
  labelClassName,
}: {
  size?: number;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <span className={cx('flex shrink-0 items-center gap-2', className)}>
      <BrandMark size={size} />
      <span className={cx('font-semibold tracking-tight', labelClassName ?? 'text-[15px]')}>
        GainingSocial
      </span>
    </span>
  );
}
