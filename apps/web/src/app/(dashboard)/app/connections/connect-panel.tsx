'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, Card, CardHeader, EmptyState } from '@/components/ui';

import { completeAuthorization, startAuthorization, type StartedAuthorization } from './actions';

/**
 * Connect an account (plan §56, §21).
 *
 * One control for both kinds of platform. The API says which kind it is with `completion`,
 * so this component branches on that rather than on a hard-coded list of which providers
 * use OAuth — a list here would go stale the first time a platform changed its auth model,
 * and the failure would be silent.
 */

interface Profile {
  id: string;
  name: string;
}

interface Platform {
  provider: string;
  display_name: string;
  available: boolean;
}

export function ConnectPanel({
  environmentId,
  profiles,
  platforms,
}: {
  environmentId: string;
  profiles: Profile[];
  platforms: Platform[];
}) {
  const router = useRouter();

  const connectable = platforms.filter((platform) => platform.available);

  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '');
  const [provider, setProvider] = useState(connectable[0]?.provider ?? '');
  const [pending, setPending] = useState<StartedAuthorization | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (profiles.length === 0) {
    return (
      <Card>
        <CardHeader title="Connect an account" />
        <EmptyState
          title="Add a profile first"
          description="A connection belongs to a profile — the brand or customer you publish on behalf of. Create one, then come back."
        />
      </Card>
    );
  }

  async function begin() {
    setBusy(true);
    setError(null);
    setDone(null);

    const result = await startAuthorization(
      profileId,
      provider,
      `${window.location.origin}/app/connections`,
    );

    setBusy(false);

    if (!result.ok || !result.data) {
      setError(result.error ?? 'Could not start the connection.');
      return;
    }

    if (result.data.completion === 'redirect') {
      // Full-page navigation rather than a popup. Popups are blocked far more often than
      // they work on mobile, and the provider controls where the user lands afterwards.
      window.location.href = result.data.authorization_url;
      return;
    }

    setCredentials({});
    setPending(result.data);
  }

  async function finish(event: React.FormEvent) {
    event.preventDefault();
    if (!pending) return;

    setBusy(true);
    setError(null);

    const result = await completeAuthorization(pending.state, credentials);
    setBusy(false);

    if (!result.ok) {
      setError(result.error ?? 'The platform rejected that credential.');
      return;
    }

    setPending(null);
    setCredentials({});
    setDone(
      result.data?.setup_complete === false
        ? 'Connected. This account has more than one destination — choose which should publish.'
        : 'Connected.',
    );

    // The list above is server-rendered; refreshing is what makes the new account appear.
    router.refresh();
  }

  return (
    <Card>
      <CardHeader
        title="Connect an account"
        description="Bluesky and Telegram work immediately. Platforms needing approval appear once their credentials are configured."
      />

      <div className="space-y-4 px-4 py-4 sm:px-5">
        {connectable.length === 0 ? (
          <p className="text-sm text-[var(--text-subtle)]">
            No platform is connectable yet. Add platform credentials before connecting an account.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="block text-sm font-medium">Profile</span>
                <select
                  value={profileId}
                  onChange={(event) => setProfileId(event.target.value)}
                  disabled={busy || pending !== null}
                  className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="block text-sm font-medium">Platform</span>
                <select
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                  disabled={busy || pending !== null}
                  className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
                >
                  {connectable.map((platform) => (
                    <option key={platform.provider} value={platform.provider}>
                      {platform.display_name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {pending === null ? (
              <Button variant="primary" onClick={begin} disabled={busy || !profileId || !provider}>
                {busy ? 'Starting…' : 'Connect'}
              </Button>
            ) : (
              <form onSubmit={finish} className="space-y-3" autoComplete="off">
                {pending.required_credential_fields.map((field) => (
                  <div key={field.name}>
                    <label htmlFor={`cred-${field.name}`} className="block text-sm font-medium">
                      {field.label}
                    </label>
                    <input
                      id={`cred-${field.name}`}
                      type={field.type === 'password' ? 'password' : 'text'}
                      required
                      value={credentials[field.name] ?? ''}
                      onChange={(event) =>
                        setCredentials((current) => ({
                          ...current,
                          [field.name]: event.target.value,
                        }))
                      }
                      className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
                    />
                    {field.help ? (
                      <p className="mt-1 text-xs text-[var(--text-subtle)]">{field.help}</p>
                    ) : null}
                  </div>
                ))}

                {pending.authorization_url ? (
                  <p className="text-xs text-[var(--text-subtle)]">
                    Need one?{' '}
                    <a
                      href={pending.authorization_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      Create it on the platform
                    </a>
                    .
                  </p>
                ) : null}

                <div className="flex gap-2">
                  <Button type="submit" variant="primary" disabled={busy}>
                    {busy ? 'Checking…' : 'Connect'}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      setPending(null);
                      setError(null);
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </>
        )}

        {/* `role="alert"` so the outcome is announced rather than only shown. */}
        {error ? (
          <p role="alert" className="text-sm text-fail-600">
            {error}
          </p>
        ) : null}
        {done ? (
          <p role="status" className="text-sm text-ok-600">
            {done}
          </p>
        ) : null}
      </div>

      <p className="sr-only">Acting in environment {environmentId}.</p>
    </Card>
  );
}
