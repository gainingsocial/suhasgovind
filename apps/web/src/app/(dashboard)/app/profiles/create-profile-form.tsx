'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, Card, CardHeader } from '@/components/ui';

import { createProfile } from './actions';

export function CreateProfileForm() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Defaulted from the browser rather than hard-coded to UTC. Scheduling is stated in the
  // profile's zone, and a wrong default puts every scheduled post an hour out.
  const [timezone, setTimezone] = useState(
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC',
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const result = await createProfile(name.trim(), timezone);
    setBusy(false);

    if (!result.ok) {
      setError(result.error ?? 'Could not create the profile.');
      return;
    }

    setName('');
    router.refresh();
  }

  return (
    <Card>
      <CardHeader
        title="New profile"
        description="One per brand, client or location you publish for"
      />
      <form onSubmit={submit} className="space-y-3 px-4 py-4 sm:px-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="block text-sm font-medium">Name</span>
            <input
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme Coffee"
              className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="block text-sm font-medium">Timezone</span>
            <input
              required
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-[var(--text-subtle)]">
              Scheduled times are interpreted in this zone.
            </span>
          </label>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-fail-600">
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="primary" disabled={busy || name.trim().length === 0}>
          {busy ? 'Creating…' : 'Create profile'}
        </Button>
      </form>
    </Card>
  );
}
