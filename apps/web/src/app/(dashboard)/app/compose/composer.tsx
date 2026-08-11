'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Badge, Button, Card, CardHeader } from '@/components/ui';

import { preflightPost, publishPost, type PreflightOutcome } from './actions';

/**
 * The composer (plan §57, P7, P16).
 *
 * Preflight runs as you stop typing, not on submit. The difference matters: a character
 * limit reported after publishing is a failure, and reported while writing it is guidance.
 * Plan P16 is explicit that a user should not have to memorize platform specifications,
 * and this is where that promise is either kept or broken.
 */

interface Profile {
  id: string;
  name: string;
}

interface Destination {
  id: string;
  profileId: string;
  provider: string;
  name: string;
  accountName: string | null;
}

/** Long enough that typing does not fire a request per keystroke, short enough to feel live. */
const PREFLIGHT_DEBOUNCE_MS = 600;

export function Composer({
  profiles,
  destinations,
}: {
  profiles: Profile[];
  destinations: Destination[];
}) {
  const router = useRouter();

  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [publishAt, setPublishAt] = useState('');
  const [preflight, setPreflight] = useState<PreflightOutcome | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<string | null>(null);

  /**
   * One idempotency key per composed post, minted before the first submit and reused on
   * every retry of that submission. Minting it per attempt would defeat the header
   * entirely — a retry after a dropped response would publish a second time (plan §25).
   */
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const profileId = destinations.find((d) => selected.includes(d.id))?.profileId ?? profiles[0]?.id ?? '';

  useEffect(() => {
    if (selected.length === 0 || text.trim().length === 0) {
      setPreflight(null);
      return;
    }

    const timer = setTimeout(async () => {
      setChecking(true);
      const result = await preflightPost(profileId, text, selected, publishAt || null);
      setChecking(false);
      if (result.ok && result.data) setPreflight(result.data);
    }, PREFLIGHT_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [text, selected, publishAt, profileId]);

  function toggle(destinationId: string) {
    setSelected((current) =>
      current.includes(destinationId)
        ? current.filter((id) => id !== destinationId)
        : [...current, destinationId],
    );
  }

  async function publish() {
    setBusy(true);
    setError(null);

    const result = await publishPost(
      profileId,
      text,
      selected,
      publishAt || null,
      idempotencyKey.current,
    );

    setBusy(false);

    if (!result.ok || !result.data) {
      setError(result.error ?? 'Could not publish.');
      return;
    }

    setPublished(result.data.id);
    setText('');
    setSelected([]);
    // A new key for the next post. Reusing the previous one would make the second post
    // return the first one's result instead of publishing.
    idempotencyKey.current = crypto.randomUUID();
    router.refresh();
  }

  const blocking = preflight?.targets.flatMap((target) => target.errors) ?? [];
  const warnings = preflight?.targets.flatMap((target) => target.warnings) ?? [];
  const canPublish =
    selected.length > 0 && text.trim().length > 0 && !busy && blocking.length === 0;

  return (
    /* Editor above preview on phones, side by side from lg. Stacking is right on a narrow
       screen: a half-width editor is unusable for writing. */
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card>
        <CardHeader title="Your post" description="Shared text, before per-destination tweaks" />
        <div className="p-4 sm:p-5">
          <label htmlFor="post-text" className="sr-only">
            Post text
          </label>
          <textarea
            id="post-text"
            rows={8}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="What do you want to say?"
            className="w-full resize-y rounded-lg border bg-[var(--surface)] p-3 text-sm outline-none placeholder:text-[var(--text-subtle)] focus-visible:border-brand-500"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-[var(--text-subtle)]">Schedule</span>
              <input
                type="datetime-local"
                value={publishAt}
                onChange={(event) => setPublishAt(event.target.value)}
                className="rounded-lg border bg-[var(--surface-raised)] px-2 py-1.5 text-sm"
              />
            </label>

            <Button variant="primary" className="ml-auto" onClick={publish} disabled={!canPublish}>
              {busy ? 'Publishing…' : publishAt ? 'Schedule' : 'Publish'}
            </Button>
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-sm text-fail-600">
              {error}
            </p>
          ) : null}

          {published ? (
            <p role="status" className="mt-3 text-sm text-ok-600">
              Accepted.{' '}
              <Link href={`/app/posts/${published}` as never} className="underline">
                Watch it publish
              </Link>
              .
            </p>
          ) : null}
        </div>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader title="Destinations" description="Where this goes" />
          {destinations.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-[var(--text-subtle)] sm:px-5">
              <Link href="/app/connections" className="underline">
                Connect an account
              </Link>{' '}
              to choose destinations.
            </div>
          ) : (
            <ul className="divide-y">
              {destinations.map((destination) => (
                <li key={destination.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-3 sm:px-5">
                    <input
                      type="checkbox"
                      checked={selected.includes(destination.id)}
                      onChange={() => toggle(destination.id)}
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{destination.name}</span>
                      <span className="block text-xs text-[var(--text-subtle)]">
                        {destination.provider.replaceAll('_', ' ')}
                        {destination.accountName ? ` · ${destination.accountName}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Preflight"
            description="Problems found before publishing"
            action={checking ? <Badge tone="busy">Checking</Badge> : null}
          />
          {preflight === null ? (
            <div className="px-4 py-6 text-center text-sm text-[var(--text-subtle)] sm:px-5">
              Checks run as you type, per destination.
            </div>
          ) : blocking.length === 0 && warnings.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ok-600 sm:px-5">
              Every destination will accept this.
            </div>
          ) : (
            <ul className="divide-y">
              {/* Blocking first. A warning above an error means the reason publishing is
                  disabled is below the fold on a phone. */}
              {[...blocking.map((f) => ({ ...f, blocking: true })), ...warnings.map((f) => ({ ...f, blocking: false }))].map(
                (finding, index) => (
                  <li key={`${finding.code}-${index}`} className="px-4 py-3 sm:px-5">
                    <div className="flex items-start gap-2">
                      <Badge tone={finding.blocking ? 'fail' : 'warn'}>
                        {finding.blocking ? 'Blocks' : 'Warning'}
                      </Badge>
                      <span className="min-w-0 text-sm">{finding.message}</span>
                    </div>
                  </li>
                ),
              )}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
