'use server';

import { revalidatePath } from 'next/cache';

import { ApiRequestError } from '@/lib/api';
import { dashboardContext, sessionFetch } from '@/lib/session-api';

/**
 * Connect actions (plan §21).
 *
 * Server Actions rather than browser `fetch`, for three reasons that all matter here: the
 * session token never leaves the server, there is no CORS configuration between the
 * dashboard and the API, and a pasted app password is submitted over the same origin the
 * page came from rather than cross-site to another host.
 */

export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

/**
 * Errors are returned, not thrown.
 *
 * A thrown Server Action error reaches the client as "an error occurred in the Server
 * Components render" with the real message stripped in production — which is correct
 * behaviour for an unexpected fault and useless for "that app password was rejected".
 * The API's envelope already carries a message written for a human, so it is passed
 * through deliberately.
 */
function failure(error: unknown): ActionResult<never> {
  if (error instanceof ApiRequestError) return { ok: false, error: error.message };
  return { ok: false, error: 'Something went wrong. Try again.' };
}

export interface StartedAuthorization {
  authorization_url: string;
  state: string;
  completion: 'redirect' | 'credential';
  required_credential_fields: {
    name: string;
    label: string;
    type: 'text' | 'password';
    help: string | null;
  }[];
}

export async function startAuthorization(
  profileId: string,
  provider: string,
  returnUrl: string,
): Promise<ActionResult<StartedAuthorization>> {
  try {
    const context = await dashboardContext();

    const started = await sessionFetch<StartedAuthorization>(context, '/v1/connections/authorize', {
      method: 'POST',
      body: { profile_id: profileId, provider, redirect_url: returnUrl },
    });

    return { ok: true, data: started };
  } catch (error) {
    return failure(error);
  }
}

export async function completeAuthorization(
  state: string,
  credentials: Record<string, string>,
): Promise<ActionResult<{ id: string; setup_complete: boolean }>> {
  try {
    const context = await dashboardContext();

    const connection = await sessionFetch<{ id: string; setup_complete: boolean }>(
      context,
      '/v1/connections/complete',
      { method: 'POST', body: { state, credentials } },
    );

    // The connections list is server-rendered, so it has to be invalidated explicitly or
    // the account that was just connected does not appear until a hard reload.
    revalidatePath('/app/connections');
    revalidatePath('/app');

    return { ok: true, data: connection };
  } catch (error) {
    return failure(error);
  }
}
