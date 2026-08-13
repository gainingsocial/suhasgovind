import Link from 'next/link';
import type { ReactNode } from 'react';

import { PlatformMark } from './platform-marks';
import { cx } from './ui';
import { PLATFORMS } from '@/lib/platforms';
import type { Faq } from '@/lib/seo';

/**
 * Marketing page furniture.
 *
 * The first version of this site had one section shape and used it five times: centred
 * heading, centred lead, diagram, then two paragraphs of small grey text. Every section
 * was structurally identical, so a reader scrolling had no way to tell where they were —
 * and the explanatory paragraphs, set at `text-sm` in muted grey, read as footnotes to
 * the diagram rather than as the argument.
 *
 * So: body copy is `text-base` in the normal text colour, and sections alternate between
 * a centred lead-in and a two-column split. The rhythm is the point.
 */

export function Section({
  id,
  tone,
  className,
  children,
}: {
  id?: string;
  tone?: 'sunken' | 'raised';
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cx(
        tone === 'sunken' && 'border-y bg-[var(--surface-sunken)]',
        tone === 'raised' && 'border-y bg-[var(--surface-raised)]',
        className,
      )}
    >
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">{children}</div>
    </section>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-semibold tracking-[0.08em] text-[var(--brand-text)] uppercase">
      {children}
    </p>
  );
}

export function SectionHeader({
  eyebrow,
  heading,
  lead,
  align = 'center',
}: {
  eyebrow?: string;
  heading: string;
  lead?: string;
  align?: 'center' | 'left';
}) {
  return (
    <div className={cx('max-w-2xl', align === 'center' && 'mx-auto text-center')}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2
        className={cx(
          'text-2xl font-semibold tracking-tight text-balance sm:text-[2rem] sm:leading-[1.15]',
          eyebrow && 'mt-3',
        )}
      >
        {heading}
      </h2>
      {lead ? (
        <p className="mt-4 text-base text-pretty text-[var(--text-muted)] sm:text-lg">{lead}</p>
      ) : null}
    </div>
  );
}

/**
 * Two-column section body.
 *
 * `reversed` swaps the columns on desktop only — on a phone the text always comes first,
 * because a reader who has to scroll past a diagram to find out what it shows has been
 * given the answer before the question.
 */
export function Split({
  media,
  children,
  reversed = false,
  className,
}: {
  media: ReactNode;
  children: ReactNode;
  reversed?: boolean;
  className?: string;
}) {
  return (
    <div className={cx('grid items-center gap-10 lg:grid-cols-2 lg:gap-14', className)}>
      <div className={cx('min-w-0', reversed && 'lg:order-2')}>{children}</div>
      <div className={cx('min-w-0', reversed && 'lg:order-1')}>{media}</div>
    </div>
  );
}

/** Readable body copy. Full size, full contrast — this is the argument, not a footnote. */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'space-y-4 text-base leading-relaxed text-pretty text-[var(--text-muted)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A short list of concrete guarantees. Ticks, because each one is a claim being made. */
export function CheckList({ items }: { items: readonly string[] }) {
  return (
    <ul className="mt-6 space-y-3">
      {items.map((item) => (
        <li key={item} className="flex gap-3 text-base text-[var(--text-muted)]">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="mt-1 shrink-0 text-[var(--brand-text)]"
          >
            <path d="m20 6-11 11-5-5" />
          </svg>
          <span className="text-pretty">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The platform strip.
 *
 * Twelve networks is the product's headline fact and the home page used to state it only
 * in prose. Names render beside every mark, so this is also twelve platform keywords in
 * real text near the top of the page.
 */
export function PlatformStrip() {
  return (
    <section className="border-y bg-[var(--surface-raised)]">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <p className="text-center text-sm text-[var(--text-subtle)]">
          One call reaches every network below.{' '}
          <Link href="/platforms" className="text-[var(--text)] underline underline-offset-4">
            See what each one needs
          </Link>
          .
        </p>
        <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-7 gap-y-5">
          {PLATFORMS.map((platform) => (
            <li key={platform.id}>
              <Link
                href="/platforms"
                className={cx(
                  'flex items-center gap-2 text-sm font-medium transition-colors',
                  platform.status === 'available'
                    ? 'text-[var(--text)]'
                    : 'text-[var(--text-subtle)] hover:text-[var(--text)]',
                )}
              >
                <PlatformMark provider={platform.id} />
                {platform.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** A band of hard numbers. Each one is checkable against the docs. */
export function StatBand({
  stats,
}: {
  stats: readonly { value: string; label: string; detail: string }[];
}) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-[var(--radius-card)] border bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="bg-[var(--surface-raised)] p-6">
          <dt className="text-sm font-medium text-[var(--text)]">{stat.label}</dt>
          <dd>
            <p className="mt-2 font-mono text-3xl font-semibold tracking-tight text-[var(--brand-text)]">
              {stat.value}
            </p>
            <p className="mt-2 text-sm text-pretty text-[var(--text-subtle)]">{stat.detail}</p>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Numbered steps.
 *
 * The number is a yellow disc carrying black rather than yellow text, which is the only
 * way this palette lets the brand colour hold weight at a small size.
 */
export function Steps({
  steps,
}: {
  steps: readonly { title: string; body: string; media?: ReactNode }[];
}) {
  return (
    <ol className="grid gap-6 lg:grid-cols-3">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className="flex flex-col rounded-[var(--radius-card)] border bg-[var(--surface-raised)] p-6"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-600 font-mono text-sm font-bold text-[var(--on-brand)]">
            {index + 1}
          </span>
          <h3 className="mt-4 text-base font-semibold">{step.title}</h3>
          <p className="mt-2 text-sm text-pretty text-[var(--text-muted)]">{step.body}</p>
          {/* `mt-auto` so the three snippets line up along the bottom even when the
              paragraphs above them differ in length. */}
          {step.media ? <div className="mt-auto pt-5">{step.media}</div> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * FAQ list.
 *
 * Rendered visible rather than inside `<details>`. Both are indexed, but a `FAQPage` block
 * whose answers are hidden behind a summary is the arrangement most likely to be flagged
 * as mismatched between the markup and the page.
 */
export function FaqList({ faqs, columns = 2 }: { faqs: readonly Faq[]; columns?: 1 | 2 }) {
  return (
    <dl className={cx('mt-10 grid gap-x-12 gap-y-8', columns === 2 && 'lg:grid-cols-2')}>
      {faqs.map((faq) => (
        <div key={faq.question} className="border-t pt-5">
          <dt className="text-base font-semibold text-balance">{faq.question}</dt>
          <dd className="mt-2.5 text-[15px] leading-relaxed text-pretty text-[var(--text-muted)]">
            {faq.answer}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ButtonLink({
  href,
  variant = 'primary',
  children,
  external = false,
}: {
  href: string;
  variant?: 'primary' | 'secondary';
  children: ReactNode;
  external?: boolean;
}) {
  const className = cx(
    'inline-flex min-h-11 items-center justify-center rounded-lg px-5 text-sm font-medium transition-colors',
    variant === 'primary'
      ? 'bg-brand-600 text-[var(--on-brand)] hover:bg-brand-500'
      : 'border bg-[var(--surface-raised)] hover:bg-[var(--surface-sunken)]',
  );

  if (external) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href as never} className={className}>
      {children}
    </Link>
  );
}

export function ClosingCta({
  heading,
  lead,
  primary,
  secondary,
}: {
  heading: string;
  lead: string;
  primary: { href: string; label: string };
  secondary?: { href: string; label: string };
}) {
  return (
    <section className="border-t bg-[var(--surface-sunken)]">
      <div className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {heading}
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base text-pretty text-[var(--text-muted)]">
          {lead}
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <ButtonLink href={primary.href}>{primary.label}</ButtonLink>
          {secondary ? (
            <ButtonLink href={secondary.href} variant="secondary">
              {secondary.label}
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </section>
  );
}
