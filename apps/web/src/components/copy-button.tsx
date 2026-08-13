'use client';

import { useEffect, useState } from 'react';

/**
 * Copy-to-clipboard for a code panel.
 *
 * The only client component on the marketing site, and deliberately tiny: everything else
 * renders on the server and ships no JavaScript.
 *
 * `navigator.clipboard` needs a secure context and is absent in a few embedded browsers,
 * so the button hides itself rather than sitting there doing nothing when pressed.
 */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(typeof navigator !== 'undefined' && Boolean(navigator.clipboard));
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
      // The label changes rather than only the icon, so a screen reader hears the result.
      aria-label={copied ? 'Copied' : 'Copy code'}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--code-dim)] transition-colors hover:bg-white/10 hover:text-[var(--code-fg)]"
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m20 6-11 11-5-5" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
