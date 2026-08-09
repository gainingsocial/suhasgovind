import { base64UrlToBytes } from '@gs/crypto';
import { ApiError } from '@gs/errors';

/**
 * Dashboard session authentication (plan §39).
 *
 * Humans authenticate through Supabase Auth, machines through API keys, and the two must
 * never be confused. A human session is a browser cookie belonging to a person with an
 * organization role; an API key is a bearer credential belonging to a project. Plan §39 is
 * explicit that a person is never authenticated by an API key and an API key never
 * inherits a person's role.
 *
 * Verification uses the project's public JWKS rather than a shared secret. Supabase now
 * signs with ES256 and publishes the public key, which means this API can verify a session
 * while holding nothing that could forge one — a leaked API deployment cannot mint
 * sessions.
 */

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface SupabaseClaims {
  sub: string;
  email?: string;
  exp: number;
  iat: number;
  iss: string;
  aud?: string | string[];
  role?: string;
  session_id?: string;
}

export interface DashboardUser {
  /** Supabase Auth user id. The join key to `organization_members`. */
  userId: string;
  email: string | null;
  /** UTC ISO-8601 (Rule 15). */
  expiresAt: string;
}

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

/**
 * JWKS cache.
 *
 * Module-level and time-bounded. Fetching the key set on every request would add a round
 * trip to every authenticated page load; never refreshing it would break the moment
 * Supabase rotates. Ten minutes is short enough that a rotation heals on its own and long
 * enough that the fetch is rare.
 */
const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

async function fetchJwks(supabaseUrl: string): Promise<Jwk[]> {
  const url = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;

  if (jwksCache && jwksCache.url === url && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new ApiError('INTERNAL_ERROR', {
      message: 'Could not fetch the Supabase JWKS to verify the session.',
    });
  }

  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache = { url, keys, fetchedAt: Date.now() };
  return keys;
}

/** Test seam, and a way to force a refresh after a known rotation. */
export function clearJwksCache(): void {
  jwksCache = null;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
}

/**
 * Verify a Supabase session token.
 *
 * The `alg` is taken from the JWK, never from the token header. Trusting the header's
 * algorithm is the classic JWT vulnerability: an attacker sets `alg: none` or downgrades
 * ES256 to HS256 and signs with the public key as if it were an HMAC secret.
 */
export async function verifyDashboardSession(
  token: string,
  options: { supabaseUrl: string; now?: Date },
): Promise<DashboardUser> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new ApiError('AUTHENTICATION_REQUIRED', { message: 'The session token is malformed.' });
  }

  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: JwtHeader;
  let claims: SupabaseClaims;
  try {
    header = decodeSegment<JwtHeader>(headerPart);
    claims = decodeSegment<SupabaseClaims>(payloadPart);
  } catch {
    throw new ApiError('AUTHENTICATION_REQUIRED', { message: 'The session token is malformed.' });
  }

  const keys = await fetchJwks(options.supabaseUrl);
  const jwk = header.kid ? keys.find((candidate) => candidate.kid === header.kid) : keys[0];

  if (!jwk) {
    // An unknown key id usually means a rotation happened after our cache was filled.
    // Refusing is correct; the next request refetches and succeeds.
    clearJwksCache();
    throw new ApiError('AUTHENTICATION_REQUIRED', {
      message: 'The session was signed with an unrecognized key.',
    });
  }

  const algorithm =
    jwk.alg === 'ES256'
      ? ({ name: 'ECDSA', namedCurve: 'P-256' } as const)
      : jwk.alg === 'RS256'
        ? ({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const)
        : null;

  if (!algorithm) {
    throw new ApiError('INTERNAL_ERROR', {
      message: `Unsupported session signing algorithm "${jwk.alg}".`,
    });
  }

  const key = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, algorithm, false, ['verify']);

  const verified = await crypto.subtle.verify(
    jwk.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
    key,
    base64UrlToBytes(signaturePart) as BufferSource,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`) as BufferSource,
  );

  if (!verified) {
    throw new ApiError('AUTHENTICATION_REQUIRED', { message: 'The session signature is invalid.' });
  }

  // Expiry is checked after the signature, not before. Checking first would let an
  // attacker probe which forged tokens have valid-looking claims.
  const now = (options.now ?? new Date()).getTime() / 1000;
  if (typeof claims.exp !== 'number' || claims.exp < now) {
    throw new ApiError('AUTHENTICATION_REQUIRED', { message: 'The session has expired.' });
  }

  if (!claims.sub) {
    throw new ApiError('AUTHENTICATION_REQUIRED', { message: 'The session has no subject.' });
  }

  return {
    userId: claims.sub,
    email: claims.email ?? null,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
