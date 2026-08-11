'use server';

import { revalidatePath } from 'next/cache';

import { ApiRequestError } from '@/lib/api';
import { dashboardContext, sessionFetch } from '@/lib/session-api';

/**
 * Compose actions (plan §57, §18).
 *
 * Preflight and publish are separate calls against the same body, which is the point:
 * plan §18 requires that what preflight validates is exactly what publishing sends, and
 * the only way to guarantee that from a UI is to send the same object to both.
 */

export interface ValidationFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  field: string | null;
}

export interface TargetValidation {
  destination_id: string;
  provider: string;
  valid: boolean;
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
}

export interface PreflightOutcome {
  valid: boolean;
  targets: TargetValidation[];
}

function body(profileId: string, text: string, destinationIds: string[], publishAt: string | null) {
  return {
    profile_id: profileId,
    content: { text, media_ids: [] },
    targets: destinationIds.map((destinationId) => ({ destination_id: destinationId })),
    ...(publishAt ? { publish_at: publishAt } : {}),
  };
}

export async function preflightPost(
  profileId: string,
  text: string,
  destinationIds: string[],
  publishAt: string | null,
): Promise<{ ok: boolean; error?: string; data?: PreflightOutcome }> {
  try {
    const context = await dashboardContext();

    const outcome = await sessionFetch<PreflightOutcome>(context, '/v1/posts/preflight', {
      method: 'POST',
      body: body(profileId, text, destinationIds, publishAt),
    });

    return { ok: true, data: outcome };
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not run preflight.' };
  }
}

export async function publishPost(
  profileId: string,
  text: string,
  destinationIds: string[],
  publishAt: string | null,
  idempotencyKey: string,
): Promise<{ ok: boolean; error?: string; data?: { id: string; status: string } }> {
  try {
    const context = await dashboardContext();

    // The idempotency key is minted by the browser before the first attempt and reused on
    // every retry of *that* submission. Generating it here instead would produce a new key
    // per retry, which is exactly the double-post the header exists to prevent.
    const post = await sessionFetch<{ id: string; status: string }>(context, '/v1/posts', {
      method: 'POST',
      body: body(profileId, text, destinationIds, publishAt),
      idempotencyKey,
    });

    revalidatePath('/app/posts');
    revalidatePath('/app');

    return { ok: true, data: post };
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not publish.' };
  }
}
