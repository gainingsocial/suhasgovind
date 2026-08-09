/**
 * S3 SigV4 presigned URLs for R2 (plan §31).
 *
 * The R2 *binding* cannot do this: a binding lets the Worker read and write objects
 * itself, which would mean streaming every upload through the Worker. A 200 MB video
 * would exceed both the request-size limit and the CPU budget, and Rule 10 forbids
 * long-running work in the request path regardless. A presigned URL lets the client PUT
 * straight to R2, and the bytes never touch us.
 *
 * Implemented against Web Crypto rather than pulled from a library because it is one
 * well-specified algorithm (AWS SigV4, query-parameter variant) and a dependency in the
 * Worker bundle costs cold-start time on every request.
 *
 * Query-parameter signing rather than header signing: the client is often a browser doing
 * a plain PUT, and it cannot be relied upon to reproduce an Authorization header exactly.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
/** R2 has no regions in the AWS sense; the signature still requires a value. */
const REGION = 'auto';

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

/**
 * RFC 3986 encoding.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped, and SigV4 requires them escaped. A key
 * containing any of them would produce a signature the server computes differently, and
 * the failure looks like a credentials problem rather than an encoding one.
 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Each path segment is encoded, but the separators are not. */
function encodeKey(key: string): string {
  return key.split('/').map(rfc3986).join('/');
}

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface PresignOptions {
  method: 'PUT' | 'GET';
  key: string;
  expiresInSeconds: number;
  /**
   * Pinned into the signature for uploads. A client that then PUTs different bytes gets a
   * signature mismatch, which stops a presigned URL for a 2 MB image being reused to
   * upload a 2 GB file.
   */
  contentType?: string;
  contentLength?: number;
}

export interface PresignedRequest {
  url: string;
  /** Headers the client must send for the signature to validate. */
  headers: Record<string, string>;
  expiresAt: string;
}

export async function presign(
  credentials: R2Credentials,
  options: PresignOptions,
): Promise<PresignedRequest> {
  const host = `${credentials.accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  // Signed headers must be exactly those the client will send. Signing a header the
  // client omits fails just as surely as omitting one it sends.
  const signedHeaders: Record<string, string> = { host };
  const clientHeaders: Record<string, string> = {};

  if (options.contentType) {
    signedHeaders['content-type'] = options.contentType;
    clientHeaders['Content-Type'] = options.contentType;
  }
  if (options.contentLength !== undefined) {
    signedHeaders['content-length'] = String(options.contentLength);
    clientHeaders['Content-Length'] = String(options.contentLength);
  }

  const headerNames = Object.keys(signedHeaders).sort();
  const canonicalHeaders = headerNames.map((name) => `${name}:${signedHeaders[name]}\n`).join('');
  const signedHeaderList = headerNames.join(';');

  const query = new URLSearchParams({
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(options.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaderList,
  });

  // Sorted by key, and encoded per RFC 3986. URLSearchParams sorts on demand and encodes
  // spaces as `+`, which SigV4 rejects, so the string is rebuilt by hand.
  const canonicalQuery = [...query.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join('&');

  const canonicalUri = `/${credentials.bucket}/${encodeKey(options.key)}`;

  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    // Presigned requests declare an unsigned payload: the body is not known when the URL
    // is created.
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  let signingKey: ArrayBuffer = await hmac(
    encoder.encode(`AWS4${credentials.secretAccessKey}`),
    dateStamp,
  );
  for (const part of [REGION, SERVICE, 'aws4_request']) {
    signingKey = await hmac(signingKey, part);
  }

  const signature = hex(await hmac(signingKey, stringToSign));

  return {
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    headers: clientHeaders,
    expiresAt: new Date(now.getTime() + options.expiresInSeconds * 1000).toISOString(),
  };
}

/**
 * Storage key layout (plan §31).
 *
 * Organization and environment are in the path so an object's tenant is visible from the
 * key alone. That matters for lifecycle rules, for bulk deletion on account closure, and
 * for spotting a mis-scoped write in a bucket listing.
 */
export function mediaStorageKey(input: {
  organizationId: string;
  projectEnvironmentId: string;
  mediaId: string;
  variant?: string;
}): string {
  return [
    'org',
    input.organizationId,
    'env',
    input.projectEnvironmentId,
    'media',
    input.mediaId,
    input.variant ?? 'original',
  ].join('/');
}
