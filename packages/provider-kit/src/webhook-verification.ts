import { hmacSha256Hex, timingSafeEqualHex, utf8ToBytes } from '@gs/crypto';

/**
 * Signature primitives for adapters that receive webhooks (plan §34).
 *
 * Re-exported through the kit rather than letting each adapter reach for `@gs/crypto`
 * directly. An adapter's dependency list stays `@gs/provider-kit`, `@gs/contracts` and
 * `@gs/errors` (plan §75), and there remains exactly one constant-time comparison in the
 * codebase — thirteen adapters each hand-rolling one is thirteen chances to write `===`.
 */

/**
 * Verify a `<prefix><hex>` HMAC-SHA256 signature over the exact raw body.
 *
 * The body must be the bytes as received. Every provider signs what it sent, and no two
 * JSON encoders agree on key order or unicode escaping, so a re-serialized body produces
 * a signature that will never match.
 */
export async function verifyHmacHexSignature(options: {
  secret: string;
  rawBody: string;
  signatureHeader: string | undefined;
  /** e.g. `sha256=` for Meta. Empty when the provider sends bare hex. */
  prefix?: string;
}): Promise<boolean> {
  const header = options.signatureHeader;
  if (!header) return false;

  const prefix = options.prefix ?? '';
  if (prefix && !header.startsWith(prefix)) return false;

  const presented = prefix ? header.slice(prefix.length) : header;
  const expected = await hmacSha256Hex(utf8ToBytes(options.secret), options.rawBody);
  return timingSafeEqualHex(presented, expected);
}

export { hmacSha256Hex, timingSafeEqualHex };
