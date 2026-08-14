'use server';

import { revalidatePath } from 'next/cache';

import { ApiRequestError } from '@/lib/api';
import { dashboardContext, sessionFetch } from '@/lib/session-api';

/**
 * Recompute what this brand's analytics say (plan Phase 10).
 *
 * Explicit, not automatic. Learning is a full scan of a profile's published posts and their
 * latest snapshots — not something to run in a request path somebody is waiting on
 * (Rule 10), and not a cost that should arrive by surprise. Safe to run twice: the result
 * is a function of the data, and the write replaces rather than appends.
 */
export async function learnNow(
  profileId: string,
  days = 90,
): Promise<{ ok: boolean; error?: string; samples?: number; observations?: number }> {
  try {
    const context = await dashboardContext();

    const result = await sessionFetch<{
      samples_considered: number;
      observations_written: number;
    }>(context, '/v1/memory/learn', {
      method: 'POST',
      body: { profile_id: profileId, days },
    });

    revalidatePath('/app/insights');

    return {
      ok: true,
      samples: result.samples_considered,
      observations: result.observations_written,
    };
  } catch (error) {
    // The API writes its messages for a human and names the field that was wrong, so they
    // pass through rather than being replaced with a generic failure.
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not refresh what we have learned. Try again.' };
  }
}
