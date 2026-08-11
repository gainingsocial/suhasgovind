'use server';

import { revalidatePath } from 'next/cache';

import { ApiRequestError } from '@/lib/api';
import { dashboardContext, sessionFetch } from '@/lib/session-api';

/**
 * Every scope a dashboard-created key gets by default.
 *
 * Deliberately the full set rather than a curated subset: a key created from the dashboard
 * is the one an integrator uses to try the product, and discovering halfway through the
 * quickstart that their key cannot upload media is a worse first impression than a broad
 * grant they can narrow later through the API.
 */
const DEFAULT_SCOPES = [
  'profiles:read',
  'profiles:write',
  'connections:read',
  'connections:write',
  'destinations:read',
  'media:read',
  'media:write',
  'posts:read',
  'posts:write',
  'capabilities:read',
  'webhooks:manage',
] as const;

export async function createApiKey(
  environmentId: string,
  name: string,
): Promise<{ ok: boolean; key?: string; error?: string }> {
  try {
    const context = await dashboardContext();

    const created = await sessionFetch<{ key: string }>(
      context,
      `/v1/api-keys?environment_id=${encodeURIComponent(environmentId)}`,
      {
        method: 'POST',
        body: { environment_id: environmentId, name, scopes: DEFAULT_SCOPES },
      },
    );

    revalidatePath('/app/keys');

    // The raw key is returned to the caller exactly once and is not stored anywhere here.
    // It is genuinely unrecoverable afterwards — keys are stored hashed under a pepper.
    return { ok: true, key: created.key };
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not create the key. Try again.' };
  }
}
