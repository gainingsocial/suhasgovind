'use server';

import { revalidatePath } from 'next/cache';

import { ApiRequestError } from '@/lib/api';
import { dashboardContext, sessionFetch } from '@/lib/session-api';

/** Create a profile (plan §55). */
export async function createProfile(
  name: string,
  timezone: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const context = await dashboardContext();

    await sessionFetch(context, '/v1/profiles', {
      method: 'POST',
      body: { name, timezone },
    });

    revalidatePath('/app/profiles');
    revalidatePath('/app');

    return { ok: true };
  } catch (error) {
    // The API's message is written for a human and names the field that was wrong, so it
    // is passed through rather than replaced with a generic failure.
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not create the profile. Try again.' };
  }
}
