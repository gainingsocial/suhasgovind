import { ApiError } from '@gs/errors';

/**
 * SSRF protection for caller-supplied media URLs (plan §68).
 *
 * A URL the caller controls, fetched from inside our network, is the classic server-side
 * request forgery vector. The prize is cloud metadata: `169.254.169.254` hands out
 * credentials to anything that asks from the right network position, and a fetch we
 * perform on a customer's behalf is exactly that position.
 *
 * This is the syntactic half — scheme, port, and literal-IP checks that can be done
 * before any network activity. The resolved-IP half has to happen at fetch time, because
 * a hostname that resolves publicly now can resolve to `127.0.0.1` a second later (DNS
 * rebinding). Both halves are required; neither is sufficient.
 */

/** Only http(s). `file:`, `gopher:`, `data:` and friends are not media transports. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Ports that are plainly not a public media host.
 *
 * A denylist rather than an allowlist because media is legitimately served from all sorts
 * of high ports behind CDNs, and an allowlist would reject valid customer infrastructure.
 * The IP checks below are the real defence; this catches the obvious internal-service
 * probe.
 */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 53, 111, 135, 139, 445, 1433, 1521, 2049, 2375, 2376, 3306, 5432, 5672, 6379,
  9200, 11211, 27017,
]);

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  return (
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, and the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 192 && b === 0) || // IETF protocol assignments, incl. 192.0.2.0/24
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}

/**
 * Expand an IPv6 address to its eight 16-bit groups.
 *
 * Necessary because the address cannot be matched as text. `URL` normalizes to the
 * shortest form and converts embedded IPv4 to hex, so `::ffff:169.254.169.254` — the
 * metadata endpoint — arrives as `::ffff:a9fe:a9fe`, and a dotted-quad regex never fires.
 * Returns null for anything unparseable, which the caller must treat as "cannot verify".
 */
function expandIPv6(value: string): number[] | null {
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const chunk of part.split(':')) {
      // A trailing dotted-quad (`::ffff:1.2.3.4`) contributes two groups.
      const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(chunk);
      if (quad) {
        const octets = quad.slice(1).map(Number);
        if (octets.some((n) => n > 255)) return null;
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
      groups.push(parseInt(chunk, 16));
    }
    return groups;
  };

  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  const groups = expandIPv6(value);

  // Rule 14 — an address we cannot parse is not assumed safe.
  if (!groups) return true;

  const [g0] = groups as [number, ...number[]];

  // Unspecified (::) and loopback (::1).
  if (groups.every((g, i) => (i === 7 ? g <= 1 : g === 0))) return true;
  // Unique local, fc00::/7.
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // Link-local, fe80::/10 — includes the IPv6 metadata address.
  if ((g0 & 0xffc0) === 0xfe80) return true;

  // IPv4-mapped, ::ffff:0:0/96. The embedded address reaches exactly the same hosts, so
  // it gets the IPv4 rules rather than being waved through.
  const isMapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const a = groups[6]!;
    const b = groups[7]!;
    return isPrivateIPv4(`${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`);
  }

  return false;
}

/** Hostnames that never legitimately serve customer media. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (BLOCKED_HOSTNAMES.has(host)) return true;
  // `.localhost`, `.internal`, `.local` and friends resolve inside a network, not outside.
  if (/\.(localhost|internal|local|home|lan|corp|intranet)$/.test(host)) return true;

  if (isPrivateIPv4(host)) return true;
  if (host.includes(':') && isPrivateIPv6(host)) return true;

  return false;
}

/**
 * Reject a media URL that must never be fetched.
 *
 * Throws rather than returning a boolean: every caller must refuse, and a boolean invites
 * one of them to log it and continue.
 */
export function assertSafeMediaUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError('MEDIA_URL_NOT_ALLOWED', {
      message: 'The media URL could not be parsed.',
      param: 'url',
    });
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new ApiError('MEDIA_URL_NOT_ALLOWED', {
      message: `\`${url.protocol}\` URLs cannot be used as media. Use https.`,
      param: 'url',
    });
  }

  // Credentials in the URL would be forwarded to whatever we fetch, and plan §68 requires
  // no credential forwarding.
  if (url.username || url.password) {
    throw new ApiError('MEDIA_URL_NOT_ALLOWED', {
      message: 'The media URL must not contain credentials.',
      param: 'url',
    });
  }

  if (url.port && BLOCKED_PORTS.has(Number(url.port))) {
    throw new ApiError('MEDIA_URL_NOT_ALLOWED', {
      message: `Port ${url.port} is not permitted for media.`,
      param: 'url',
    });
  }

  if (isBlockedHost(url.hostname)) {
    throw new ApiError('MEDIA_URL_NOT_ALLOWED', {
      message: 'The media URL points at a private, loopback or link-local address.',
      param: 'url',
    });
  }

  return url;
}

/**
 * Fetch limits for the eventual probe (plan §68).
 *
 * Exported here so the media-processing worker and this route cannot disagree about them.
 */
export const MEDIA_FETCH_LIMITS = {
  maxBytes: 512 * 1024 * 1024,
  timeoutMs: 30_000,
  /**
   * Each hop is re-validated. A URL that passes every check and then 302s to
   * `169.254.169.254` is the standard bypass, so following redirects blindly undoes
   * everything above.
   */
  maxRedirects: 3,
} as const;
