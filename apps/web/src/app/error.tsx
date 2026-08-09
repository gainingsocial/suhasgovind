'use client';

import { useEffect } from 'react';

/**
 * Route error boundary.
 *
 * Shows the digest rather than the raw error. Next redacts server error messages in
 * production precisely because they can carry internal detail, and the digest is what
 * correlates this screen with the server log — which is the thing support actually needs.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-1 max-w-sm text-sm text-[var(--text-subtle)]">
        This page failed to load. Trying again often works — the underlying request may
        simply have timed out.
      </p>
      {error.digest ? (
        <p className="mt-3 font-mono text-xs text-[var(--text-subtle)]">
          Reference: {error.digest}
        </p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="mt-5 inline-flex min-h-9 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-[var(--on-brand)]"
      >
        Try again
      </button>
    </div>
  );
}
