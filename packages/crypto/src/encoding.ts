/**
 * Byte/string encoding helpers.
 *
 * Everything here uses Web Crypto primitives available identically in Cloudflare Workers,
 * Node 22 and the browser, so adapters and tests share one implementation (ADR-001).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8ToBytes(value: string): Uint8Array {
  return encoder.encode(value);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** URL-safe base64 without padding — used for tokens that travel in URLs and headers. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  return base64ToBytes(remainder === 0 ? padded : padded + '='.repeat(4 - remainder));
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Constant-time comparison.
 *
 * Every signature, API-key hash and session-token check must use this. A `===` on a
 * secret-derived string leaks its prefix through timing, which is enough to forge a
 * signature byte by byte.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Comparing lengths early is safe: length is not secret, and a length mismatch
  // cannot be exploited to learn content.
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(utf8ToBytes(a), utf8ToBytes(b));
}
