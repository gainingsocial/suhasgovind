'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { Button } from '@/components/ui';
import { browserClient } from '@/lib/supabase-browser';

/**
 * The one client component in the dashboard that talks to Supabase directly.
 *
 * Everything else reads through the API with the session token, so this is the only place
 * an auth SDK is loaded at all — which keeps the credential surface to a single file.
 */
function Form() {
  const params = useSearchParams();
  const next = params.get('next') ?? '/app';

  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState('sending');
    setError(null);

    try {
      const { error: sendError } = await browserClient().auth.signInWithOtp({
        email,
        options: {
          // Relative to the current origin so the same build works on localhost, a preview
          // deploy and production without a per-environment redirect list.
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });

      if (sendError) throw sendError;
      setState('sent');
    } catch (cause) {
      setState('idle');
      setError(cause instanceof Error ? cause.message : 'Could not send the link. Try again.');
    }
  }

  if (state === 'sent') {
    return (
      <div className="mt-6 rounded-lg border bg-[var(--surface-raised)] p-4">
        <p className="text-sm font-medium">Check your email</p>
        <p className="mt-1 text-sm text-[var(--text-subtle)]">
          We sent a sign-in link to <span className="font-medium">{email}</span>. It expires in an
          hour.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
          placeholder="you@company.com"
        />
      </div>

      {error ? (
        // `role="alert"` so a screen reader announces the failure instead of leaving the
        // person waiting on a button that silently did nothing.
        <p role="alert" className="text-sm text-fail-600">
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="w-full" disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Email me a link'}
      </Button>
    </form>
  );
}

/** `useSearchParams` suspends during prerender, so the boundary is required. */
export function SignInForm() {
  return (
    <Suspense fallback={<div className="mt-6 h-32 animate-pulse rounded-lg bg-[var(--surface-sunken)]" />}>
      <Form />
    </Suspense>
  );
}
