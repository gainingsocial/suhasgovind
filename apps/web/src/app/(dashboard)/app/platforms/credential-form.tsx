'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, Card, CardHeader } from '@/components/ui';

import { saveProviderApp } from './actions';

interface Platform {
  provider: string;
  display_name: string;
}

/**
 * Paste a client id and secret (plan §23).
 *
 * The secret field is never repopulated from the server, even after a successful save.
 * It cannot be — the API does not return it by any route — and showing a masked
 * placeholder would imply a value is recoverable when it is not.
 */
export function CredentialForm({ platforms }: { platforms: Platform[] }) {
  const router = useRouter();

  const [provider, setProvider] = useState(platforms[0]?.provider ?? '');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [ownership, setOwnership] = useState<'customer_managed' | 'platform_managed'>(
    'customer_managed',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  if (platforms.length === 0) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);

    const result = await saveProviderApp(provider, clientId.trim(), clientSecret.trim(), ownership);
    setBusy(false);

    if (!result.ok) {
      setError(result.error ?? 'Could not save the credentials.');
      return;
    }

    // Cleared immediately. A secret left in a form field survives a back-navigation and
    // ends up in a browser's session restore.
    setClientSecret('');
    setClientId('');
    setSaved(`${provider.replaceAll('_', ' ')} is now configured.`);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader
        title="Add credentials"
        description="Stored encrypted, exactly like a user token, and never shown again"
      />
      <form onSubmit={submit} className="space-y-3 px-4 py-4 sm:px-5" autoComplete="off">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="block text-sm font-medium">Platform</span>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
            >
              {platforms.map((platform) => (
                <option key={platform.provider} value={platform.provider}>
                  {platform.display_name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-sm font-medium">Application</span>
            <select
              value={ownership}
              onChange={(event) =>
                setOwnership(event.target.value as 'customer_managed' | 'platform_managed')
              }
              className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
            >
              <option value="customer_managed">Mine — scoped to this project</option>
              <option value="platform_managed">Shared — every customer (operators only)</option>
            </select>
          </label>
        </div>

        <label className="block">
          <span className="block text-sm font-medium">Client ID</span>
          <input
            required
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 font-mono text-sm"
          />
        </label>

        <label className="block">
          <span className="block text-sm font-medium">Client secret</span>
          <input
            required
            type="password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 font-mono text-sm"
          />
          <span className="mt-1 block text-xs text-[var(--text-subtle)]">
            Encrypted on arrival. No endpoint returns it — re-read it from the platform’s console
            if you need it again.
          </span>
        </label>

        {error ? (
          <p role="alert" className="text-sm text-fail-600">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="text-sm text-ok-600">
            {saved}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          disabled={busy || clientId.trim().length === 0 || clientSecret.trim().length === 0}
        >
          {busy ? 'Saving…' : 'Save credentials'}
        </Button>
      </form>
    </Card>
  );
}
