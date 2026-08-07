import { base64ToBytes, bytesToBase64Url, bytesToHex, timingSafeEqual, utf8ToBytes } from './encoding.js';

/** Low-level HMAC-SHA256 helpers shared by API keys, webhook signing and signed tokens. */

async function importHmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    secret as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function hmacSha256(secret: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, message as BufferSource);
  return new Uint8Array(signature);
}

export async function hmacSha256Hex(secret: string | Uint8Array, message: string): Promise<string> {
  const secretBytes = typeof secret === 'string' ? utf8ToBytes(secret) : secret;
  return bytesToHex(await hmacSha256(secretBytes, utf8ToBytes(message)));
}

export async function hmacSha256Base64Url(
  secret: string | Uint8Array,
  message: string,
): Promise<string> {
  const secretBytes = typeof secret === 'string' ? utf8ToBytes(secret) : secret;
  return bytesToBase64Url(await hmacSha256(secretBytes, utf8ToBytes(message)));
}

export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8ToBytes(message) as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/** Verify an HMAC in constant time. Never compare signatures with `===`. */
export async function verifyHmacSha256Hex(
  secret: string | Uint8Array,
  message: string,
  expectedHex: string,
): Promise<boolean> {
  const actual = await hmacSha256Hex(secret, message);
  return timingSafeEqual(utf8ToBytes(actual), utf8ToBytes(expectedHex));
}

/** Decode a base64 secret from configuration, failing loudly on malformed input. */
export function decodeSecret(name: string, value: string | undefined): Uint8Array {
  if (!value) {
    throw new Error(`Secret ${name} is not configured.`);
  }
  const bytes = base64ToBytes(value);
  if (bytes.length < 16) {
    throw new Error(`Secret ${name} must be at least 16 bytes of base64-encoded material.`);
  }
  return bytes;
}
