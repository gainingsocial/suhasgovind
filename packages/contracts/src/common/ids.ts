/**
 * Resource identifiers (plan §13.1).
 *
 * Two representations of the same 128 bits:
 *
 *   internal  — canonical UUIDv7 string, the `uuid` column type in Postgres
 *   public    — `pst_01k1q9m4pz7f3v8h2n6d0rjxab`, prefixed Crockford base32
 *
 * The mapping is a bijection, so there is no second column to keep in sync and no lookup
 * table. UUIDv7 is time-ordered, which keeps b-tree inserts sequential and makes
 * `ORDER BY id` a usable proxy for creation order.
 *
 * Sequential database IDs are never exposed (plan §13.1): they leak volume and let a
 * caller enumerate another tenant's resources.
 */

/** Every public resource prefix. The prefix is part of the API contract. */
export const ID_PREFIXES = {
  organization: 'org',
  project: 'prj',
  environment: 'env',
  profile: 'pro',
  connection: 'con',
  destination: 'dst',
  media: 'med',
  mediaVariant: 'mdv',
  post: 'pst',
  postTarget: 'ptg',
  attempt: 'att',
  webhookEndpoint: 'wh',
  webhookDelivery: 'whd',
  event: 'evt',
  apiKey: 'key',
  connectSession: 'cs',
  oauthSession: 'oas',
  providerApp: 'app',
  request: 'req',
  trace: 'trc',
  job: 'job',
  idempotency: 'idm',
  approval: 'apr',
  auditEvent: 'aud',
  // Content Intelligence (plan §63Q). No underscores — the separator between prefix and
  // body is `_`, so a prefix containing one would make parsing ambiguous.
  contentSource: 'src',
  sourceItem: 'itm',
  draftSet: 'dfs',
  draft: 'drf',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];
export type ResourceKind = keyof typeof ID_PREFIXES;

// ---------------------------------------------------------------------------
// UUIDv7
// ---------------------------------------------------------------------------

let lastTimestamp = -1;
let lastCounter = 0;

/**
 * Generate a UUIDv7 (RFC 9562 §5.7): 48-bit big-endian Unix millisecond timestamp,
 * 4-bit version, 12-bit sub-millisecond counter, 2-bit variant, 62 random bits.
 *
 * The 12-bit counter (rand_a used as "replace left-most random bits with increased
 * clock precision", RFC 9562 §6.2 method 1) keeps IDs generated within the same
 * millisecond strictly increasing. Without it, a burst of posts created in one
 * millisecond would sort arbitrarily, and `ORDER BY id` would stop matching creation
 * order — which the post timeline and cursor pagination both rely on.
 *
 * `now` is clamped to the last timestamp already used, so a clock that jumps backwards
 * (NTP correction, leap second, a Worker isolate on a drifted machine) cannot emit an ID
 * that sorts before one already handed out. A consequence worth knowing: passing an
 * explicitly older `now` does NOT produce an older ID. The argument exists for testing
 * and for backfills, not to rewrite history.
 */
export function newUuidV7(now: number = Date.now()): string {
  const timestamp = Math.max(now, lastTimestamp);

  if (timestamp === lastTimestamp) {
    lastCounter += 1;
    // 12 bits exhausted within one millisecond: step into the next millisecond rather
    // than wrap, which would break monotonicity.
    if (lastCounter > 0xfff) {
      lastCounter = 0;
      lastTimestamp = timestamp + 1;
      return newUuidV7(lastTimestamp);
    }
  } else {
    lastTimestamp = timestamp;
    lastCounter = Math.floor(Math.random() * 0x1000);
  }

  const bytes = new Uint8Array(16);

  // 48-bit timestamp, big-endian.
  bytes[0] = Math.floor(lastTimestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(lastTimestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(lastTimestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(lastTimestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(lastTimestamp / 2 ** 8) & 0xff;
  bytes[5] = lastTimestamp & 0xff;

  // Version 7 in the high nibble of byte 6, then the 12-bit counter.
  bytes[6] = 0x70 | ((lastCounter >> 8) & 0x0f);
  bytes[7] = lastCounter & 0xff;

  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  bytes.set(random, 8);

  // RFC 4122 variant bits `10` in the two most significant bits of byte 8.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return bytesToUuidString(bytes);
}

function bytesToUuidString(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < 16; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidStringToBytes(uuid: string): Uint8Array | null {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Extract the creation time encoded in a UUIDv7. Useful for retention sweeps. */
export function uuidV7Timestamp(uuid: string): Date | null {
  const bytes = uuidStringToBytes(uuid);
  if (!bytes) return null;

  const millis =
    bytes[0]! * 2 ** 40 +
    bytes[1]! * 2 ** 32 +
    bytes[2]! * 2 ** 24 +
    bytes[3]! * 2 ** 16 +
    bytes[4]! * 2 ** 8 +
    bytes[5]!;

  return new Date(millis);
}

// ---------------------------------------------------------------------------
// Crockford base32 — the public representation
// ---------------------------------------------------------------------------

/** Crockford's alphabet: no I, L, O or U, so a transcribed ID cannot be misread. */
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

const CROCKFORD_LOOKUP: Record<string, number> = {};
for (let i = 0; i < CROCKFORD.length; i += 1) {
  const char = CROCKFORD[i]!;
  CROCKFORD_LOOKUP[char] = i;
  CROCKFORD_LOOKUP[char.toUpperCase()] = i;
}
// Crockford's documented decoding aliases for the excluded letters.
Object.assign(CROCKFORD_LOOKUP, { i: 1, I: 1, l: 1, L: 1, o: 0, O: 0 });

/** 16 bytes → 26 base32 characters (130 bits, top 2 bits always zero). */
function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}

function decodeBase32(text: string): Uint8Array | null {
  const bytes = new Uint8Array(16);
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (const char of text) {
    const value = CROCKFORD_LOOKUP[char];
    if (value === undefined) return null;

    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      if (index >= 16) return null;
      bytes[index] = (buffer >>> (bits - 8)) & 0xff;
      index += 1;
      bits -= 8;
    }
  }

  return index === 16 ? bytes : null;
}

// ---------------------------------------------------------------------------
// Public IDs
// ---------------------------------------------------------------------------

/** Branded string type so a raw string cannot be passed where a public ID is required. */
export type PublicId<K extends ResourceKind = ResourceKind> = string & { readonly __kind?: K };

export function toPublicId<K extends ResourceKind>(kind: K, uuid: string): PublicId<K> {
  const bytes = uuidStringToBytes(uuid);
  if (!bytes) {
    throw new Error(`Cannot build a public ID from "${uuid}": not a UUID.`);
  }
  return `${ID_PREFIXES[kind]}_${encodeBase32(bytes)}`;
}

/**
 * Decode a public ID back to its UUID, verifying the prefix.
 *
 * Returns `null` rather than throwing on bad input: callers turn that into a
 * `*_NOT_FOUND` error, which is exactly what a caller passing another tenant's
 * malformed ID should see.
 */
export function fromPublicId<K extends ResourceKind>(kind: K, publicId: string): string | null {
  const expected = `${ID_PREFIXES[kind]}_`;
  if (!publicId.startsWith(expected)) return null;

  const body = publicId.slice(expected.length);
  if (body.length !== 26) return null;

  const bytes = decodeBase32(body);
  return bytes ? bytesToUuidString(bytes) : null;
}

/** Generate a fresh pair for a new resource. */
export function newId<K extends ResourceKind>(kind: K): { uuid: string; publicId: PublicId<K> } {
  const uuid = newUuidV7();
  return { uuid, publicId: toPublicId(kind, uuid) };
}

/** Shape check without decoding. Used by Zod schemas for fast request rejection. */
export function isPublicId(kind: ResourceKind, value: string): boolean {
  return fromPublicId(kind, value) !== null;
}

/** Which resource kind a public ID claims to be, or null if unrecognized. */
export function resourceKindOf(publicId: string): ResourceKind | null {
  const separator = publicId.indexOf('_');
  if (separator <= 0) return null;

  const prefix = publicId.slice(0, separator);
  for (const [kind, candidate] of Object.entries(ID_PREFIXES)) {
    if (candidate === prefix) return kind as ResourceKind;
  }
  return null;
}

/**
 * Correlation identifiers (plan §40). Generated per request and propagated through
 * queues, workflows and provider calls so one identifier reconstructs the whole story.
 */
export function newRequestId(): string {
  return toPublicId('request', newUuidV7());
}

export function newTraceId(): string {
  return toPublicId('trace', newUuidV7());
}
