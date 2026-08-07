import { timingSafeEqualHex, utf8ToBytes } from './encoding.js';
import { hmacSha256Base64Url, hmacSha256Hex } from './hmac.js';

/**
 * Outbound customer webhook signing (plan §36).
 *
 * We sign `timestamp.rawBody` with HMAC-SHA256 so a customer can verify both authenticity
 * and freshness. Signing the *exact raw body* matters: if a customer re-serializes JSON
 * before verifying, key order or whitespace changes break the signature — so our docs and
 * SDK verify against the raw bytes.
 */

export const WEBHOOK_HEADERS = {
  eventId: 'X-Social-Event-Id',
  timestamp: 'X-Social-Timestamp',
  signature: 'X-Social-Signature',
  attempt: 'X-Social-Attempt',
} as const;

/** Reject signatures older than this to resist replay (plan §36). */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const SECRET_DISPLAY_PREFIX = 'whsec_';

/**
 * Per-endpoint signing secrets are DERIVED from a root held in Secrets Store rather than
 * stored per endpoint.
 *
 * Consequences, both deliberate:
 *  - there is no plaintext webhook secret in the database to leak;
 *  - rotation is a version bump, and the previous version stays derivable during overlap.
 */
export async function deriveWebhookSecret(
  root: Uint8Array,
  endpointId: string,
  secretVersion: number,
): Promise<string> {
  const derived = await hmacSha256Base64Url(root, `webhook-endpoint|${endpointId}|v${secretVersion}`);
  return `${SECRET_DISPLAY_PREFIX}${derived}`;
}

/** The exact string that gets signed. Shared by us and by the customer's verifier. */
export function webhookSigningPayload(timestamp: number, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/**
 * Produce the `X-Social-Signature` value.
 *
 * Format is `v1=<hex>`, a versioned scheme so a future algorithm change can be rolled out
 * by sending both versions in one header before retiring the old one.
 */
export async function signWebhookPayload(
  secret: string,
  timestamp: number,
  rawBody: string,
): Promise<string> {
  const mac = await hmacSha256Hex(secret, webhookSigningPayload(timestamp, rawBody));
  return `v1=${mac}`;
}

export interface WebhookVerificationInput {
  secret: string;
  rawBody: string;
  signatureHeader: string;
  timestampHeader: string;
  toleranceSeconds?: number;
  /** Injectable for deterministic tests. Seconds since epoch. */
  nowSeconds?: number;
}

export type WebhookVerificationResult =
  | { valid: true }
  | { valid: false; reason: 'malformed_timestamp' | 'timestamp_out_of_tolerance' | 'no_matching_signature' };

/**
 * Reference verifier. Shipped in the SDK and documented so customers verify correctly —
 * the most common webhook security bug is a customer comparing signatures with `===` or
 * skipping the timestamp check entirely.
 */
export async function verifyWebhookSignature(
  input: WebhookVerificationInput,
): Promise<WebhookVerificationResult> {
  const timestamp = Number(input.timestampHeader);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { valid: false, reason: 'malformed_timestamp' };
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = await signWebhookPayload(input.secret, timestamp, input.rawBody);

  // The header may carry several space-separated versions during a rotation overlap.
  // Every candidate is compared in constant time; we do not short-circuit on the first.
  let matched = false;
  for (const candidate of input.signatureHeader.trim().split(/\s+/)) {
    if (timingSafeEqualHex(candidate, expected)) {
      matched = true;
    }
  }

  return matched ? { valid: true } : { valid: false, reason: 'no_matching_signature' };
}

/**
 * Verify an INBOUND provider webhook signed as `sha256=<hex>` over the raw body —
 * the convention Meta and several other providers use (plan §34).
 *
 * The exact header name and prefix differ per provider, so each adapter supplies them.
 */
export async function verifyProviderHmacSignature(options: {
  secret: string;
  rawBody: string;
  signatureHeader: string;
  prefix?: string;
}): Promise<boolean> {
  const prefix = options.prefix ?? 'sha256=';
  const presented = options.signatureHeader.startsWith(prefix)
    ? options.signatureHeader.slice(prefix.length)
    : options.signatureHeader;

  const expected = await hmacSha256Hex(utf8ToBytes(options.secret), options.rawBody);
  return timingSafeEqualHex(presented, expected);
}
