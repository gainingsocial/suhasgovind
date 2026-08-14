'use server';

import { revalidatePath } from 'next/cache';

import { ApiRequestError } from '@/lib/api';
import { dashboardContext, sessionFetch } from '@/lib/session-api';

/**
 * Autopilot control actions (creator plan §5.4).
 *
 * Each of these is an ordinary public API call the customer could have made themselves —
 * rule C7. Nothing here is UI-only logic, which is what keeps the studio honest as proof
 * that the API is complete.
 */

type Result = { ok: boolean; error?: string };

/**
 * Approve or reject a held post.
 *
 * The API applies the decision and *then* releases or cancels the post, in that order, so a
 * crash between the two can never leave a post published against an approval that still
 * reads pending.
 */
export async function decideApproval(
  approvalId: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<Result> {
  try {
    const context = await dashboardContext();

    await sessionFetch(context, `/v1/approvals/${approvalId}/decide`, {
      method: 'POST',
      body: { decision, ...(note ? { note } : {}) },
    });

    revalidatePath('/app/autopilot');
    revalidatePath('/app');

    return { ok: true };
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not record that decision. Try again.' };
  }
}

/**
 * Change how much a source is trusted to do on its own.
 *
 * The three modes are the product's whole automation model, and moving between them is a
 * one-field change rather than a settings page: `draft_only` writes and stops,
 * `approval_required` writes and waits for a person, `auto_publish_if_safe` writes and
 * publishes when preflight and policy both pass.
 */
export async function setAutomationMode(
  sourceId: string,
  mode: 'draft_only' | 'approval_required' | 'auto_publish_if_safe',
): Promise<Result> {
  try {
    const context = await dashboardContext();

    await sessionFetch(context, `/v1/content-sources/${sourceId}`, {
      method: 'PATCH',
      body: { automation_mode: mode },
    });

    revalidatePath('/app/autopilot');

    return { ok: true };
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not change the automation level. Try again.' };
  }
}

/** Connect a feed or page so its new items become drafts. */
export async function addContentSource(input: {
  kind: 'rss' | 'url' | 'webhook';
  url: string;
  name: string;
  profileId: string;
  mode: 'draft_only' | 'approval_required' | 'auto_publish_if_safe';
}): Promise<Result> {
  try {
    const context = await dashboardContext();

    await sessionFetch(context, '/v1/content-sources', {
      method: 'POST',
      body: {
        kind: input.kind,
        url: input.url,
        name: input.name,
        profile_id: input.profileId,
        automation_mode: input.mode,
      },
    });

    revalidatePath('/app/autopilot');

    return { ok: true };
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not add that source. Check the address and try again.' };
  }
}

/** Record a fact, a rule or a phrase the automation must respect. */
export async function addBrandMemory(input: {
  profileId: string;
  kind: 'product' | 'audience' | 'competitor' | 'vocabulary' | 'campaign' | 'faq' | 'banned_claim';
  label: string;
  body: string;
}): Promise<Result> {
  try {
    const context = await dashboardContext();

    await sessionFetch(context, `/v1/memory/brand?profile_id=${input.profileId}`, {
      method: 'POST',
      body: { kind: input.kind, label: input.label, body: input.body },
    });

    revalidatePath('/app/autopilot');

    return { ok: true };
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not save that. Try again.' };
  }
}

export async function removeBrandMemory(profileId: string, entryId: string): Promise<Result> {
  try {
    const context = await dashboardContext();

    await sessionFetch(context, `/v1/memory/brand/${entryId}?profile_id=${profileId}`, {
      method: 'DELETE',
    });

    revalidatePath('/app/autopilot');

    return { ok: true };
  } catch (error) {
    if (error instanceof ApiRequestError) return { ok: false, error: error.message };
    return { ok: false, error: 'Could not remove that. Try again.' };
  }
}
