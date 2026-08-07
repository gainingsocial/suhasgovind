import { base64UrlToBytes, bytesToBase64Url, bytesToUtf8, timingSafeEqualHex, utf8ToBytes } from './encoding.js';
import { hmacSha256Base64Url } from './hmac.js';

/**
 * Compact signed tokens for hosted connect sessions and OAuth state (plan §21, §22).
 *
 * Deliberately not JWT. JWT's algorithm agility is a well-known footgun (`alg: none`,
 * HS/RS confusion) and we need none of its flexibility: one issuer, one verifier, one
 * algorithm. The format is `<base64url(payload)>.<base64url(hmac)>` with the algorithm
 * pinned by the `v` field inside the payload.
 *
 * A token is a capability, not an identity. Everything it authorizes is re-checked
 * server-side against the database when it is redeemed (plan P5).
 */

export interface SignedTokenClaims {
  /** Token purpose. Verification requires an exact match, so a connect-session token
   *  can never be replayed as an OAuth state token. */
  purpose: string;
  /** Subject — typically the session or resource ID this token grants access to. */
  sub: string;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Issued at, seconds since epoch. */
  iat: number;
  /** Arbitrary purpose-specific claims. Never put secrets here — the payload is only
   *  signed, not encrypted, and is readable by anyone holding the token. */
  data?: Record<string, string | number | boolean>;
}

interface TokenPayload extends SignedTokenClaims {
  v: 1;
}

export type TokenVerificationFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'purpose_mismatch'
  | 'unsupported_version';

export type TokenVerificationResult =
  | { valid: true; claims: SignedTokenClaims }
  | { valid: false; reason: TokenVerificationFailure };

export interface IssueTokenInput {
  secret: Uint8Array;
  purpose: string;
  subject: string;
  ttlSeconds: number;
  data?: Record<string, string | number | boolean>;
  /** Injectable for deterministic tests. Seconds since epoch. */
  nowSeconds?: number;
}

export async function issueSignedToken(input: IssueTokenInput): Promise<string> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  const payload: TokenPayload = {
    v: 1,
    purpose: input.purpose,
    sub: input.subject,
    iat: now,
    exp: now + input.ttlSeconds,
    ...(input.data ? { data: input.data } : {}),
  };

  const encoded = bytesToBase64Url(utf8ToBytes(JSON.stringify(payload)));
  const signature = await hmacSha256Base64Url(input.secret, encoded);
  return `${encoded}.${signature}`;
}

export interface VerifyTokenInput {
  secret: Uint8Array;
  token: string;
  /** Required. Prevents a token minted for one purpose being redeemed for another. */
  expectedPurpose: string;
  nowSeconds?: number;
}

export async function verifySignedToken(input: VerifyTokenInput): Promise<TokenVerificationResult> {
  const parts = input.token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };

  const [encoded, signature] = parts as [string, string];

  // Signature is checked BEFORE the payload is parsed, so unauthenticated input never
  // reaches JSON.parse or any claim logic.
  const expected = await hmacSha256Base64Url(input.secret, encoded);
  if (!timingSafeEqualHex(signature, expected)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(bytesToUtf8(base64UrlToBytes(encoded))) as TokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (payload.v !== 1) return { valid: false, reason: 'unsupported_version' };
  if (typeof payload.exp !== 'number' || typeof payload.sub !== 'string') {
    return { valid: false, reason: 'malformed' };
  }
  if (payload.purpose !== input.expectedPurpose) {
    return { valid: false, reason: 'purpose_mismatch' };
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now >= payload.exp) return { valid: false, reason: 'expired' };

  const { v: _version, ...claims } = payload;
  return { valid: true, claims };
}

/** Token purposes in use. Kept central so a typo cannot silently create a new namespace. */
export const TOKEN_PURPOSE = {
  connectSession: 'connect_session',
  oauthState: 'oauth_state',
  mediaUpload: 'media_upload',
} as const;
