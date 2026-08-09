/**
 * Explanatory diagrams.
 *
 * Inline SVG rather than images, for four reasons that all matter:
 *
 *   crawlable    the text is real text, so it contributes to the page's topical relevance
 *                instead of being invisible pixels
 *   theme-aware  `currentColor` and CSS variables mean one drawing works in light and
 *                dark, rather than shipping two PNGs and picking wrong
 *   instant      no extra request, so they never delay Largest Contentful Paint
 *   accessible   `<title>` and `role="img"` give screen readers something real
 *
 * Each one explains an actual mechanism. A diagram that is decoration wastes the reader's
 * attention and teaches nothing — if it cannot be described in a sentence that a customer
 * would care about, it should not exist.
 */

interface DiagramProps {
  className?: string;
}

const LABEL = 'fill-[var(--text)] text-[11px] font-medium';
const MUTED = 'fill-[var(--text-subtle)] text-[10px]';

function Frame({
  title,
  description,
  viewBox,
  className,
  children,
}: DiagramProps & {
  title: string;
  description: string;
  viewBox: string;
  children: React.ReactNode;
}) {
  return (
    <figure className={className}>
      <svg
        viewBox={viewBox}
        role="img"
        aria-labelledby={`${title.replace(/\s+/g, '-')}-title`}
        className="w-full"
        // Scales to the container on every screen. A fixed width is the usual reason a
        // diagram overflows on a phone.
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={`${title.replace(/\s+/g, '-')}-title`}>{title}</title>
        <desc>{description}</desc>
        {children}
      </svg>
      <figcaption className="mt-3 text-center text-sm text-[var(--text-subtle)]">
        {description}
      </figcaption>
    </figure>
  );
}

/** Rounded node with a label. */
function Node({
  x,
  y,
  w = 108,
  h = 40,
  label,
  sub,
  tone = 'neutral',
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  label: string;
  sub?: string;
  tone?: 'neutral' | 'brand' | 'ok' | 'warn' | 'fail';
}) {
  const fill = {
    neutral: 'var(--surface-raised)',
    brand: 'var(--color-brand-100)',
    ok: 'var(--color-ok-100)',
    warn: 'var(--color-warn-100)',
    fail: 'var(--color-fail-100)',
  }[tone];

  const stroke = {
    neutral: 'var(--border-strong)',
    brand: 'var(--color-brand-500)',
    ok: 'var(--color-ok-600)',
    warn: 'var(--color-warn-600)',
    fail: 'var(--color-fail-600)',
  }[tone];

  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={fill} stroke={stroke} strokeWidth={1.25} />
      <text x={x + w / 2} y={sub ? y + h / 2 - 2 : y + h / 2 + 4} textAnchor="middle" className={LABEL}>
        {label}
      </text>
      {sub ? (
        <text x={x + w / 2} y={y + h / 2 + 12} textAnchor="middle" className={MUTED}>
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2, dashed = false }: { x1: number; y1: number; x2: number; y2: number; dashed?: boolean }) {
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke="var(--border-strong)"
      strokeWidth={1.5}
      markerEnd="url(#arrowhead)"
      {...(dashed ? { strokeDasharray: '4 3' } : {})}
    />
  );
}

function Defs() {
  return (
    <defs>
      <marker id="arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
        <polygon points="0 0, 7 3.5, 0 7" fill="var(--border-strong)" />
      </marker>
    </defs>
  );
}

/**
 * One post, many platforms.
 *
 * The core promise, and the thing every visitor is trying to understand in the first ten
 * seconds.
 */
export function FanOutDiagram({ className }: DiagramProps) {
  const targets = [
    { label: 'Bluesky', y: 10 },
    { label: 'LinkedIn', y: 62 },
    { label: 'Instagram', y: 114 },
    { label: 'TikTok', y: 166 },
  ];

  return (
    <Frame
      className={className}
      title="One post published to four social networks"
      description="You write once. Each network receives a version it will actually accept."
      viewBox="0 0 520 220"
    >
      <Defs />
      <Node x={4} y={88} w={120} h={44} label="Your post" sub="written once" tone="brand" />
      <Node x={188} y={88} w={116} h={44} label="GainingSocial" sub="one API call" />
      <Arrow x1={126} y1={110} x2={185} y2={110} />

      {targets.map((target) => (
        <g key={target.label}>
          <path
            d={`M 306 110 C 340 110, 340 ${target.y + 20}, 372 ${target.y + 20}`}
            fill="none"
            stroke="var(--border-strong)"
            strokeWidth={1.5}
            markerEnd="url(#arrowhead)"
          />
          <Node x={378} y={target.y} w={132} h={40} label={target.label} tone="ok" />
        </g>
      ))}
    </Frame>
  );
}

/**
 * Preflight.
 *
 * Explains the difference between finding out before and finding out after — which is
 * the single most persuasive thing about the product and the hardest to convey in prose.
 */
export function PreflightDiagram({ className }: DiagramProps) {
  return (
    <Frame
      className={className}
      title="Problems are found before publishing, not after"
      description="Every destination is checked against its own rules first, so a rejection never reaches your audience half-finished."
      viewBox="0 0 520 210"
    >
      <Defs />
      <Node x={4} y={82} w={104} h={44} label="Your post" tone="brand" />
      <Arrow x1={110} y1={104} x2={158} y2={104} />
      <Node x={162} y={82} w={112} h={44} label="Preflight" sub="checks each one" />

      <path d="M 276 104 C 306 104, 306 34, 336 34" fill="none" stroke="var(--border-strong)" strokeWidth={1.5} markerEnd="url(#arrowhead)" />
      <Node x={342} y={14} w={172} h={40} label="Fits — publishes" tone="ok" />

      <path d="M 276 104 C 306 104, 306 104, 336 104" fill="none" stroke="var(--border-strong)" strokeWidth={1.5} markerEnd="url(#arrowhead)" />
      <Node x={342} y={84} w={172} h={40} label="Too long — trim it" sub="told before posting" tone="warn" />

      <path d="M 276 104 C 306 104, 306 172, 336 172" fill="none" stroke="var(--border-strong)" strokeWidth={1.5} markerEnd="url(#arrowhead)" />
      <Node x={342} y={152} w={172} h={40} label="Wrong image size" sub="with a suggested fix" tone="fail" />
    </Frame>
  );
}

/**
 * Duplicate prevention.
 *
 * The subtlest and most valuable guarantee, and impossible to explain without showing
 * the timeout case: the post lands, the confirmation is lost, and a naive system posts
 * it twice.
 */
export function EffectiveOnceDiagram({ className }: DiagramProps) {
  return (
    <Frame
      className={className}
      title="How a lost confirmation avoids becoming a duplicate post"
      description="If the network accepts a post but the confirmation never arrives, we check before retrying — so you never post twice."
      viewBox="0 0 520 240"
    >
      <Defs />
      <Node x={4} y={14} w={124} h={40} label="Publish" tone="brand" />
      <Arrow x1={130} y1={34} x2={186} y2={34} />
      <Node x={190} y={14} w={140} h={40} label="Network accepts it" tone="ok" />

      <path d="M 260 56 L 260 88" stroke="var(--color-fail-600)" strokeWidth={1.5} strokeDasharray="4 3" markerEnd="url(#arrowhead)" />
      <Node x={186} y={92} w={148} h={40} label="Reply is lost" sub="network glitch" tone="fail" />

      <path d="M 260 134 L 260 166" stroke="var(--border-strong)" strokeWidth={1.5} markerEnd="url(#arrowhead)" />
      <Node x={158} y={170} w={204} h={44} label="We check the account first" sub="was it actually posted?" tone="warn" />

      <path d="M 362 192 C 400 192, 400 34, 420 34" fill="none" stroke="var(--border-strong)" strokeWidth={1.5} markerEnd="url(#arrowhead)" />
      <Node x={392} y={14} w={124} h={40} label="Found it" sub="no second post" tone="ok" />

      <text x={392} y={192} className={MUTED}>
        Not found → safe to retry
      </text>
    </Frame>
  );
}

/** Scheduling and the safety net that makes "scheduled" mean something. */
export function SchedulingDiagram({ className }: DiagramProps) {
  return (
    <Frame
      className={className}
      title="How a scheduled post reaches its audience on time"
      description="A background check runs every minute, so a scheduled post still goes out even if something upstream fails."
      viewBox="0 0 520 170"
    >
      <Defs />
      <Node x={4} y={62} w={112} h={44} label="Scheduled" sub="for 9:00am" tone="brand" />
      <Arrow x1={118} y1={84} x2={166} y2={84} />
      <Node x={170} y={62} w={132} h={44} label="Waiting" sub="checked every minute" />
      <Arrow x1={304} y1={84} x2={352} y2={84} />
      <Node x={356} y={62} w={158} h={44} label="Published at 9:00am" tone="ok" />

      <text x={236} y={26} textAnchor="middle" className={MUTED}>
        If anything fails, the check picks it back up
      </text>
      <path d="M 236 34 C 236 46, 236 46, 236 58" stroke="var(--border-strong)" strokeWidth={1.25} strokeDasharray="3 3" />
    </Frame>
  );
}
