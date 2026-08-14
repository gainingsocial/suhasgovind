'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui';
import { learnNow } from './actions';

/**
 * Recompute findings on demand.
 *
 * Reports what it did rather than only that it finished. "Read 48 posts, found 3 patterns"
 * and "read 48 posts, found nothing" are very different answers, and a spinner that
 * resolves to a silently unchanged page makes the second one look like a bug.
 */
export function LearnButton({ profileId }: { profileId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {message ? (
        <span
          role="status"
          className={
            message.tone === 'ok'
              ? 'text-xs text-[var(--text-subtle)]'
              : 'text-xs text-fail-600'
          }
        >
          {message.text}
        </span>
      ) : null}

      <Button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setMessage(null);
            const result = await learnNow(profileId);

            if (!result.ok) {
              setMessage({ tone: 'fail', text: result.error ?? 'Could not refresh.' });
              return;
            }

            setMessage({
              tone: 'ok',
              text:
                result.observations === 0
                  ? `Read ${result.samples ?? 0} posts — nothing stood out yet.`
                  : `Read ${result.samples ?? 0} posts, found ${result.observations} pattern${
                      result.observations === 1 ? '' : 's'
                    }.`,
            });
          })
        }
      >
        {pending ? 'Reading your posts…' : 'Refresh findings'}
      </Button>
    </div>
  );
}
