'use client';

import { useState, useTransition } from 'react';

import { Button, cx } from '@/components/ui';
import {
  addBrandMemory,
  addContentSource,
  decideApproval,
  removeBrandMemory,
  setAutomationMode,
} from './actions';

export type AutomationMode = 'draft_only' | 'approval_required' | 'auto_publish_if_safe';

/** The three levels, in the words the plan uses for them (creator plan §5.4). */
export const MODE_LABEL: Record<AutomationMode, string> = {
  draft_only: 'Draft only',
  approval_required: 'Ask me first',
  auto_publish_if_safe: 'Full autopilot',
};

export const MODE_HELP: Record<AutomationMode, string> = {
  draft_only: 'Writes drafts and stops. Nothing leaves without you.',
  approval_required: 'Writes drafts and holds them for your approval.',
  auto_publish_if_safe: 'Publishes on its own when every check passes. Anything doubtful still asks.',
};

function Error({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-2 text-xs text-fail-600">
      {message}
    </p>
  );
}

/**
 * Approve or reject a held post.
 *
 * Two plain buttons rather than a menu. This is the one interaction on the page a person
 * performs many times in a row, and burying either half of it behind a click would make the
 * common case slower to serve the rare one.
 */
export function ApprovalDecision({ approvalId }: { approvalId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const decide = (decision: 'approved' | 'rejected') =>
    startTransition(async () => {
      setError(null);
      const result = await decideApproval(approvalId, decision);
      if (!result.ok) setError(result.error ?? 'Could not record that.');
    });

  return (
    <div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="primary" disabled={pending} onClick={() => decide('approved')}>
          Approve
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => decide('rejected')}>
          Reject
        </Button>
      </div>
      <Error message={error} />
    </div>
  );
}

/**
 * Change a source's automation level.
 *
 * Three segmented options rather than a dropdown: the whole point of this control is that a
 * person can see how much autonomy they have granted without opening anything.
 */
export function ModePicker({
  sourceId,
  current,
}: {
  sourceId: string;
  current: AutomationMode;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<AutomationMode>(current);
  const [error, setError] = useState<string | null>(null);

  const choose = (mode: AutomationMode) => {
    if (mode === value) return;

    // Optimistic: the control is the only thing on screen that reflects this state, so
    // waiting for a round trip would make every tap feel broken on a slow connection.
    const previous = value;
    setValue(mode);
    setError(null);

    startTransition(async () => {
      const result = await setAutomationMode(sourceId, mode);
      if (!result.ok) {
        setValue(previous);
        setError(result.error ?? 'Could not change that.');
      }
    });
  };

  return (
    <div>
      <div
        className="inline-flex flex-wrap gap-1 rounded-lg bg-[var(--surface-sunken)] p-1"
        role="group"
        aria-label="Automation level"
      >
        {(Object.keys(MODE_LABEL) as AutomationMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={pending}
            onClick={() => choose(mode)}
            aria-pressed={value === mode}
            title={MODE_HELP[mode]}
            className={cx(
              'min-h-8 rounded-md px-2.5 text-xs font-medium transition-colors disabled:opacity-60',
              value === mode
                ? 'bg-[var(--surface-raised)] text-[var(--text)] shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
          >
            {MODE_LABEL[mode]}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-[var(--text-subtle)]">{MODE_HELP[value]}</p>
      <Error message={error} />
    </div>
  );
}

/** Connect a feed. Collapsed until asked for, so the page is not a form. */
export function AddSourceForm({ profileId }: { profileId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        Connect a feed
      </Button>
    );
  }

  return (
    <form
      className="w-full space-y-3 sm:max-w-md"
      action={(formData) =>
        startTransition(async () => {
          setError(null);
          const result = await addContentSource({
            kind: (formData.get('kind') as 'rss' | 'url' | 'webhook') ?? 'rss',
            url: String(formData.get('url') ?? ''),
            name: String(formData.get('name') ?? ''),
            profileId,
            mode: (formData.get('mode') as AutomationMode) ?? 'approval_required',
          });

          if (result.ok) setOpen(false);
          else setError(result.error ?? 'Could not add that source.');
        })
      }
    >
      <label className="block">
        <span className="text-xs font-medium">What is it called?</span>
        <input
          name="name"
          required
          placeholder="Company blog"
          className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
        />
      </label>

      <label className="block">
        <span className="text-xs font-medium">Address</span>
        <input
          name="url"
          type="url"
          required
          placeholder="https://example.com/feed.xml"
          className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium">Kind</span>
          <select
            name="kind"
            defaultValue="rss"
            className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
          >
            <option value="rss">RSS feed</option>
            <option value="url">Single page</option>
            <option value="webhook">Webhook</option>
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium">Start at</span>
          <select
            name="mode"
            // Assisted by default (rule C3). A new source that could publish on its own the
            // moment it is added is how somebody loses trust in the feature permanently.
            defaultValue="approval_required"
            className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
          >
            <option value="draft_only">Draft only</option>
            <option value="approval_required">Ask me first</option>
            <option value="auto_publish_if_safe">Full autopilot</option>
          </select>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Connecting…' : 'Connect'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>

      <Error message={error} />
    </form>
  );
}

/** Teach the automation a fact, a phrase or a hard limit. */
export function AddMemoryForm({ profileId }: { profileId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        Add a rule
      </Button>
    );
  }

  return (
    <form
      className="w-full space-y-3 sm:max-w-md"
      action={(formData) =>
        startTransition(async () => {
          setError(null);
          const result = await addBrandMemory({
            profileId,
            kind: formData.get('kind') as never,
            label: String(formData.get('label') ?? ''),
            body: String(formData.get('body') ?? ''),
          });

          if (result.ok) setOpen(false);
          else setError(result.error ?? 'Could not save that.');
        })
      }
    >
      <label className="block">
        <span className="text-xs font-medium">Kind</span>
        <select
          name="kind"
          defaultValue="vocabulary"
          className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
        >
          <option value="vocabulary">Words we use</option>
          <option value="banned_claim">Never say this</option>
          <option value="product">A product</option>
          <option value="audience">Who we talk to</option>
          <option value="competitor">A competitor</option>
          <option value="campaign">A campaign</option>
          <option value="faq">A question we get asked</option>
        </select>
      </label>

      <label className="block">
        <span className="text-xs font-medium">Short name</span>
        <input
          name="label"
          required
          placeholder="No medical claims"
          className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
        />
      </label>

      <label className="block">
        <span className="text-xs font-medium">The detail</span>
        <textarea
          name="body"
          rows={3}
          placeholder="Never describe the product as treating, curing or preventing any condition."
          className="mt-1 w-full rounded-lg border bg-[var(--surface-raised)] px-3 py-2 text-sm"
        />
      </label>

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>

      <Error message={error} />
    </form>
  );
}

export function RemoveMemoryButton({
  profileId,
  entryId,
}: {
  profileId: string;
  entryId: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      aria-label="Remove this rule"
      onClick={() => startTransition(() => removeBrandMemory(profileId, entryId).then(() => undefined))}
      className="rounded p-1.5 text-[var(--text-subtle)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-fail-600 disabled:opacity-50"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
      </svg>
    </button>
  );
}
