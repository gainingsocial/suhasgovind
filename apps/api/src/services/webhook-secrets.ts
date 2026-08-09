import { decodeSecret, deriveWebhookSecret as derive } from '@gs/crypto';
import { ApiError } from '@gs/errors';

import type { Env } from '../env.js';

/**
 * Binds the webhook signing root from the Worker environment to the derivation in
 * `@gs/crypto`.
 *
 * The derivation itself lives in crypto because the delivery worker and any future
 * verification tooling need the identical function — two implementations of a signing
 * scheme is two chances to disagree, and the symptom would be signatures customers cannot
 * verify.
 */

/**
 * How long the previous secret keeps verifying after a rotation.
 *
 * Long enough for a customer to notice, redeploy and confirm; short enough that a leaked
 * secret is not honoured indefinitely.
 */
export const PREVIOUS_SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;

export async function deriveWebhookSecret(
  env: Env,
  endpointId: string,
  version: number,
): Promise<string> {
  if (!env.WEBHOOK_SIGNING_ROOT) {
    // Rule 14 — a deployment fault, stated precisely rather than surfacing later as an
    // endpoint whose signatures nobody can verify.
    throw new ApiError('INTERNAL_ERROR', {
      message: 'Webhook signing is not configured: WEBHOOK_SIGNING_ROOT is unset.',
    });
  }

  return derive(decodeSecret('WEBHOOK_SIGNING_ROOT', env.WEBHOOK_SIGNING_ROOT), endpointId, version);
}
