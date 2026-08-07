/**
 * Secret redaction for logs and persisted provider request/response records
 * (plan §7.2, §40).
 *
 * This is the last line of defence, not the first. The first is never passing a secret
 * to a logger. But provider payloads are large, nested and change without notice, so
 * anything persisted goes through here.
 *
 * The design is deny-by-pattern on KEY NAMES rather than allow-listing, because an
 * allow-list silently starts leaking the moment a provider adds a field.
 */

const REDACTED = '[REDACTED]';

/**
 * Key names whose values are always removed. Matched case-insensitively against the
 * whole key and against `snake_case` / `camelCase` / `kebab-case` variants.
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /^authorization$/i,
  /^proxy-authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /(^|[._-])access[._-]?token($|[._-])/i,
  /(^|[._-])refresh[._-]?token($|[._-])/i,
  /(^|[._-])id[._-]?token($|[._-])/i,
  /(^|[._-])bearer($|[._-])/i,
  /(^|[._-])client[._-]?secret($|[._-])/i,
  /(^|[._-])app[._-]?secret($|[._-])/i,
  /(^|[._-])api[._-]?key($|[._-])/i,
  /(^|[._-])secret($|[._-])/i,
  /(^|[._-])password($|[._-])/i,
  /(^|[._-])passwd($|[._-])/i,
  /(^|[._-])credential($|[._-])/i,
  /(^|[._-])private[._-]?key($|[._-])/i,
  /(^|[._-])signature($|[._-])/i,
  /(^|[._-])session[._-]?token($|[._-])/i,
  /^code$/i, // OAuth authorization code
  /^code_verifier$/i,
  /^state$/i, // OAuth state — not secret, but not useful in logs and often correlatable
  /^assertion$/i,
  /^pepper$/i,
  /^kek$/i,
];

/**
 * Value-level patterns caught even when the key looks innocuous — a token pasted into a
 * `message` or `note` field, for example.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk_(?:live|test)_[A-Za-z0-9_-]{16,}/g, // our own API keys
  /\bwhsec_[A-Za-z0-9_-]{16,}/g, // our webhook secrets
  /\bEA[A-Za-z0-9]{20,}/g, // Meta access tokens
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub personal tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export interface RedactOptions {
  /** Extra key names to redact — e.g. a provider-specific field. */
  additionalKeys?: readonly RegExp[];
  /** Guard against pathological nesting in untrusted provider payloads. */
  maxDepth?: number;
  /** Truncate long strings so one payload cannot fill the log budget. */
  maxStringLength?: number;
}

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_STRING = 2048;

/**
 * Deep-redact an arbitrary value for logging or persistence.
 *
 * Returns a new structure; the input is never mutated, because callers frequently log a
 * payload they are about to send.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxString = options.maxStringLength ?? DEFAULT_MAX_STRING;
  const extraKeys = options.additionalKeys ?? [];
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input;

    if (typeof input === 'string') {
      const cleaned = redactString(input);
      return cleaned.length > maxString ? `${cleaned.slice(0, maxString)}…[truncated]` : cleaned;
    }

    if (typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input === 'bigint') return input.toString();
    if (typeof input === 'function' || typeof input === 'symbol') return undefined;

    if (depth >= maxDepth) return '[MAX_DEPTH]';

    if (input instanceof Date) return input.toISOString();
    if (input instanceof Error) {
      return { name: input.name, message: redactString(input.message) };
    }

    if (typeof input === 'object') {
      // Provider payloads and our own request objects can contain cycles.
      if (seen.has(input)) return '[CIRCULAR]';
      seen.add(input);

      if (Array.isArray(input)) {
        return input.map((item) => walk(item, depth + 1));
      }

      if (input instanceof Headers) {
        const out: Record<string, unknown> = {};
        input.forEach((headerValue, headerKey) => {
          out[headerKey] = isSecretKey(headerKey) ? REDACTED : redactString(headerValue);
        });
        return out;
      }

      if (input instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [mapKey, mapValue] of input) {
          const keyText = String(mapKey);
          out[keyText] = isSecretKey(keyText) ? REDACTED : walk(mapValue, depth + 1);
        }
        return out;
      }

      const out: Record<string, unknown> = {};
      for (const [objectKey, objectValue] of Object.entries(input as Record<string, unknown>)) {
        if (isSecretKey(objectKey) || extraKeys.some((pattern) => pattern.test(objectKey))) {
          out[objectKey] = REDACTED;
        } else {
          out[objectKey] = walk(objectValue, depth + 1);
        }
      }
      return out;
    }

    return String(input);
  };

  return walk(value, 0);
}

/** Redact a URL's query string — OAuth callbacks carry `code` and `state` there. */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretKey(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return redactString(rawUrl);
  }
}

export { REDACTED, isSecretKey };
