import type { ReactNode } from 'react';

/**
 * Shared UI primitives.
 *
 * Small and unstyled-by-default rather than a component library: the dashboard has a
 * handful of shapes (card, badge, button, empty state) and pulling in a full library
 * would ship far more CSS than those shapes need.
 */

type Tone = 'neutral' | 'ok' | 'warn' | 'fail' | 'busy' | 'brand';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-[var(--surface-sunken)] text-[var(--text-muted)]',
  ok: 'bg-ok-100 text-ok-600',
  warn: 'bg-warn-100 text-warn-600',
  fail: 'bg-fail-100 text-fail-600',
  busy: 'bg-busy-100 text-busy-600',
  brand: 'bg-brand-100 text-brand-600',
};

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

/**
 * Status badge.
 *
 * Carries a text label as well as colour. Colour alone fails for the ~4% of people with
 * a colour vision deficiency, and "published" versus "failed" is exactly the distinction
 * they must not lose (plan §61).
 */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag
      className={cx(
        'rounded-[var(--radius-card)] border bg-[var(--surface-raised)]',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    // Wraps rather than truncating on narrow screens: a heading that turns into an
    // ellipsis on a phone tells the reader nothing.
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5 sm:py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-sm text-[var(--text-subtle)]">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-[var(--on-brand)] hover:bg-brand-500',
  secondary:
    'border bg-[var(--surface-raised)] text-[var(--text)] hover:bg-[var(--surface-sunken)]',
  ghost: 'text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]',
  danger: 'bg-fail-600 text-white hover:opacity-90',
};

export function Button({
  variant = 'secondary',
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={cx(
        // min-h-9 keeps every control at a comfortable tap target on touch screens.
        'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium',
        'transition-colors disabled:pointer-events-none disabled:opacity-50',
        BUTTON_CLASSES[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * Empty state.
 *
 * Every list has one, and each says what to do next rather than just "no results" —
 * an empty dashboard is the first thing a new integrator sees (plan §61).
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon ? <div className="mb-3 text-[var(--text-subtle)]">{icon}</div> : null}
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-[var(--text-subtle)]">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Placeholder block for an async view. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton rounded-md', className)} aria-hidden="true" />;
}

/**
 * Opaque resource id with a copy button.
 *
 * Plan §61 asks for copy buttons on ids: they are long, prefixed and impossible to
 * retype, and the first thing anyone does in a support conversation is quote one.
 */
export function ResourceId({ id, label }: { id: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label ? <span className="text-[var(--text-subtle)]">{label}</span> : null}
      <code className="rounded bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-xs">
        {id}
      </code>
      <CopyButton value={id} />
    </span>
  );
}

export function CopyButton({ value }: { value: string }) {
  return (
    <button
      type="button"
      // Server components cannot carry handlers, so the copy is inline. `data-copied`
      // gives the confirmation without a client component for something this small.
      data-copy={value}
      aria-label="Copy to clipboard"
      className="rounded p-1 text-[var(--text-subtle)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>
  );
}

/**
 * Timestamp.
 *
 * Stored and transmitted in UTC (Rule 15); rendered in the reader's own timezone, because
 * "did this go out at the right time" is not a question anyone should answer by doing
 * arithmetic. The ISO value stays in `dateTime` and the tooltip so the exact instant is
 * never lost.
 */
export function Timestamp({ iso, relative = true }: { iso: string; relative?: boolean }) {
  const date = new Date(iso);

  return (
    <time dateTime={iso} title={iso} suppressHydrationWarning>
      {relative ? formatRelative(date) : date.toLocaleString()}
    </time>
  );
}

function formatRelative(date: Date): string {
  const deltaMs = date.getTime() - Date.now();
  const abs = Math.abs(deltaMs);

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 1000],
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
  ];

  // Beyond a week a relative label stops helping — "in 23 days" is harder to act on than
  // the date itself.
  if (abs > 7 * 86_400_000) return date.toLocaleDateString();

  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0]!;
  for (const unit of units) if (abs >= unit[1]) chosen = unit;

  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    Math.round(deltaMs / chosen[1]),
    chosen[0],
  );
}

/**
 * Map a target or post status onto a tone and a human label.
 *
 * One place, so a status never renders green in one view and grey in another. The labels
 * are deliberately plain: "Waiting on the platform" beats `provider_processing`.
 */
export function statusPresentation(status: string): { tone: Tone; label: string } {
  switch (status) {
    case 'published':
      return { tone: 'ok', label: 'Published' };
    case 'partially_published':
      // Warn, not ok. Some destinations failed, and an aggregate green would hide that
      // (plan §61).
      return { tone: 'warn', label: 'Partly published' };
    case 'publishing':
      return { tone: 'busy', label: 'Publishing' };
    case 'provider_processing':
      return { tone: 'busy', label: 'Waiting on the platform' };
    case 'queued':
      return { tone: 'busy', label: 'Queued' };
    case 'scheduled':
      return { tone: 'brand', label: 'Scheduled' };
    case 'preparing_media':
      return { tone: 'busy', label: 'Preparing media' };
    case 'retryable_failed':
      return { tone: 'warn', label: 'Retrying' };
    case 'permanent_failed':
    case 'failed':
      return { tone: 'fail', label: 'Failed' };
    case 'unknown_reconciliation_required':
      // Genuinely unknown, and saying so is the honest thing. Calling it "failed" would
      // invite a retry that could duplicate a post that actually published.
      return { tone: 'warn', label: 'Checking with the platform' };
    case 'cancelled':
      return { tone: 'neutral', label: 'Cancelled' };
    case 'awaiting_approval':
      return { tone: 'brand', label: 'Awaiting approval' };
    case 'blocked_validation':
      return { tone: 'fail', label: 'Blocked' };
    case 'draft':
      return { tone: 'neutral', label: 'Draft' };
    case 'healthy':
      return { tone: 'ok', label: 'Connected' };
    case 'refresh_due':
    case 'refreshing':
      return { tone: 'busy', label: 'Refreshing' };
    case 'reauth_required':
      return { tone: 'fail', label: 'Reconnect needed' };
    case 'permission_missing':
      return { tone: 'fail', label: 'Missing permission' };
    case 'rate_limited':
      return { tone: 'warn', label: 'Rate limited' };
    case 'provider_degraded':
      return { tone: 'warn', label: 'Platform degraded' };
    case 'disconnected':
      return { tone: 'neutral', label: 'Disconnected' };
    case 'revoked':
      return { tone: 'fail', label: 'Access revoked' };
    default:
      return { tone: 'neutral', label: status.replace(/_/g, ' ') };
  }
}
