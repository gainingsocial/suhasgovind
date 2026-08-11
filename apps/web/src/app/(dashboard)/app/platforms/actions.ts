'use server';

import { revalidatePath } from 'next/cache';

import { ApiRequestError } from '@/lib/api';
import { dashboardContext, sessionFetch } from '@/lib/session-api';

/**
 * Platform credential actions (plan §23).
 *
 * The secret is posted through a Server Action so it goes to our own origin over the same
 * connection the page came from, and never sits in browser memory longer than the form
 * submission. It is encrypted the moment it reaches the API and is not readable afterwards
 * by any endpoint.
 */
export async function saveProviderApp(
  provider: string,
  clientId: string,
  clientSecret: string,
  ownership: 'customer_managed' | 'platform_managed',
): Promise<{ ok: boolean; error?: string }> {
  try {
    const context = await dashboardContext();

    await sessionFetch(
      context,
      `/v1/provider-apps?environment_id=${encodeURIComponent(context.environment.id)}`,
      {
        method: 'POST',
        body: {
          provider,
          client_id: clientId,
          client_secret: clientSecret,
          ownership,
        },
      },
    );

    revalidatePath('/app/platforms');
    // Connecting becomes possible the moment credentials land, so the page that offers it
    // has to be re-rendered too.
    revalidatePath('/app/connections');

    return { ok: true };
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not save the credentials. Try again.' };
  }
}
