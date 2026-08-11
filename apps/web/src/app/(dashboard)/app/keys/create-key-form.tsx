'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, Card, CardHeader, CopyButton } from '@/components/ui';

import { createApiKey } from './actions';

/**
 * Create a key, and show it exactly once.
 *
 * The one-time display is not a UI choice — keys are stored hashed under a pepper, so the
 * value genuinely cannot be recovered afterwards. Saying so plainly is what stops somebody
 * closing the panel expecting to find it again later.
 */
export function CreateKeyForm({ environmentId }: { environmentId: string }) {
  const router = useRouter();

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const result = await createApiKey(environmentId, name.trim());
    setBusy(false);

    if (!result.ok || !result.key) {
      setError(result.error ?? 'Could not create the key.');
      return;
    }

    setCreated(result.key);
    setName('');
    router.refresh();
  }

  return (
    <Card>
      <CardHeader title="New key" description="Shown once, then never again" />

      <div className="space-y-4 px-4 py-4 sm:px-5">
        {created ? (
          <div className="rounded-lg border border-brand-600 bg-[var(--surface-sunken)] p-3">
            <p className="text-sm font-medium">Copy this now</p>
            <p className="mt-1 text-xs text-[var(--text-subtle)]">
              This is the only time the key is shown. It is stored hashed, so it cannot be
              recovered — if you lose it, create another and revoke this one.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-[var(--surface-raised)] px-2 py-1.5 font-mono text-xs">
                {created}
              </code>
              <CopyButton value={created} />
            </div>
            <Button className="mt-3" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <label className="block">
              <span className="block text-sm font-medium">Name</span>
              <input
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Production backend"
                className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-xs text-[var(--text-subtle)]">
                For your own reference. Name it after where it will be used.
              </span>
            </label>

            {error ? (
              <p role="alert" className="text-sm text-fail-600">
                {error}
              </p>
            ) : null}

            <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
              {busy ? 'Creating…' : 'Create key'}
            </Button>
          </form>
        )}
      </div>
    </Card>
  );
}
