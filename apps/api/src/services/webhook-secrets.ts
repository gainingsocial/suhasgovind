import { hmacSha256Base64Url } from '@gs/crypto';
import { ApiError } from '@gs/errors';

import type { Env } from '../env.js';

/**
 * Per-endpoint webhook signing secrets (plan §36, ADR-007).
 *
 * Derived from a single root in Secrets Store, never stored per endpoint. Three reasons
 * that is the right shape:
 *
 *   - a database dump yields no signing secrets, only version numbers
 *   - rotation is an integer increment, not a write of new secret material
 *   - the previous version stays derivable during the overlap window, so a customer can
 *     deploy the new secret without dropping deliveries in the gap
 *
 * The cost is that the root is load-bearing: losing it invalidates every endpoint's
 * secret at once. It lives in Worker Secrets and is never logged (P9).
 */

/**
 * How long the previous secret keeps verifying after a rotation.
 *
 * Long enough for a customer to notice, redeploy and confirm; short enough that a leaked
 * secret is not honoured indefinitely.
 */
export const PREVIOUS_SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * Derive the signing secret for one endpoint at one version.
 *
 * The endpoint id and version are both in the message, so two endpoints never share a
 * secret and a rotated secret is unrelated to its predecessor.
 */
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

  return `whsec_${await hmacSha256Base64Url(env.WEBHOOK_SIGNING_ROOT, `${endpointId}.v${version}`)}`;
}

/**
 * Build the signature header value for a delivery attempt (plan §36).
 *
 * Signs `timestamp.payload` over the **exact raw body** — not a re-serialization. A
 * customer verifies against the bytes they received, and any re-encoding on our side
 * (key order, whitespace, unicode escaping) would produce a signature that cannot be
 * reproduced.
 *
 * The timestamp is inside the signed material specifically so a captured delivery cannot
 * be replayed later: a verifier that checks signature alone accepts a week-old body.
 */
export async function signWebhookPayload(
  secret: string,
  timestamp: number,
  rawBody: string,
): Promise<string> {
  return `v1=${await hmacSha256Base64Url(secret, `${timestamp}.${rawBody}`)}`;
}
