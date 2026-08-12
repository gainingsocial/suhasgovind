import { verifyHmacHexSignature } from '@gs/provider-kit';
import type {
  ProviderEventKind,
  ProviderWebhookRequest,
  ProviderWebhookResult,
  VerifiedProviderEvent,
} from '@gs/provider-kit';

/**
 * Shared inbound webhook handling for the Meta family (plan §34).
 *
 * Official documentation consulted (Rule 2):
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-pages
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-instagram
 *
 * Facebook, Instagram and Threads share one webhook protocol exactly: the same
 * `hub.challenge` handshake, the same `X-Hub-Signature-256` scheme, and the same
 * `{ object, entry[] }` envelope. Implementing it three times would be three chances to
 * get constant-time comparison wrong.
 */

/** Meta signs the raw body with the app secret and sends it here, hex, `sha256=` prefixed. */
const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';

/**
 * Verify `X-Hub-Signature-256`.
 *
 * Compared in constant time. A `===` here leaks the correct signature one byte at a time
 * to anyone willing to measure, which is the whole reason the header exists.
 */
export async function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<boolean> {
  return verifyHmacHexSignature({
    secret: appSecret,
    rawBody,
    signatureHeader,
    prefix: SIGNATURE_PREFIX,
  });
}

/**
 * The subscription handshake.
 *
 * Meta issues a GET carrying `hub.mode=subscribe`, `hub.verify_token` and an integer
 * `hub.challenge`, and expects the challenge echoed as a bare body. The verify token must
 * be checked: without it, anyone who learns the callback URL can complete our
 * subscription setup for their own app.
 */
export function metaHandshake(
  request: ProviderWebhookRequest,
): Extract<ProviderWebhookResult, { kind: 'handshake' }> {
  const params = new URL(request.url).searchParams;
  const mode = params.get('hub.mode');
  const challenge = params.get('hub.challenge');
  const token = params.get('hub.verify_token');

  const ok =
    mode === 'subscribe' &&
    challenge !== null &&
    request.verifyToken !== null &&
    token === request.verifyToken;

  return ok
    ? { kind: 'handshake', status: 200, body: challenge, contentType: 'text/plain' }
    : { kind: 'handshake', status: 403, body: '', contentType: 'text/plain' };
}

/** Meta's envelope. One POST carries many entries, each with many changes. */
interface MetaWebhookBody {
  object?: string;
  entry?: MetaEntry[];
}

interface MetaEntry {
  /** The Page, IG account or Threads user the entry concerns. */
  id?: string;
  /** Unix seconds. Meta sends seconds, not milliseconds. */
  time?: number;
  changes?: MetaChange[];
  /** Messaging-style entries use a different key; carried through untouched. */
  messaging?: unknown[];
}

interface MetaChange {
  field?: string;
  value?: Record<string, unknown>;
}

/**
 * Map a Meta `field` onto the engine's vocabulary.
 *
 * Only fields whose meaning is documented and unambiguous are classified. Everything else
 * is `unrecognized` on purpose — a wrong guess at `permissions` would disconnect a
 * working account, and Meta adds fields faster than any allow-list can track.
 */
function classify(field: string | undefined): ProviderEventKind {
  switch (field) {
    /**
     * Documented on the `user` object: fires when a user removes a permission, including
     * removing the app entirely. Treated as revocation only when the payload confirms it.
     */
    case 'permissions':
      return 'permissions_changed';
    case 'comments':
    case 'live_comments':
    case 'mentions':
    case 'message_reactions':
      return 'engagement';
    case 'name':
    case 'picture':
    case 'username':
      return 'account_updated';
    default:
      return 'unrecognized';
  }
}

/**
 * `permissions` changes carry the affected permissions and their status. A revocation of
 * the login permission itself is a full disconnect; losing a publishing scope is not.
 */
function refinePermissions(value: Record<string, unknown> | undefined): ProviderEventKind {
  const list = Array.isArray(value?.['permissions']) ? (value['permissions'] as unknown[]) : [];
  const revokedAll = list.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as Record<string, unknown>)['permission'] === 'public_profile' &&
      (entry as Record<string, unknown>)['status'] === 'revoked',
  );
  return revokedAll ? 'authorization_revoked' : 'permissions_changed';
}

/**
 * Carve a verified Meta POST into normalized events.
 *
 * Meta supplies no per-event identifier, so `externalEventId` stays `null` and the engine
 * fingerprints instead (plan §10.4). Synthesizing an id from `entry.id + time` would look
 * like deduplication while quietly collapsing two genuinely different changes that landed
 * in the same second.
 */
export function parseMetaEvents(rawBody: string, object: string): VerifiedProviderEvent[] {
  let body: MetaWebhookBody;
  try {
    body = JSON.parse(rawBody) as MetaWebhookBody;
  } catch {
    return [];
  }

  const events: VerifiedProviderEvent[] = [];

  for (const entry of body.entry ?? []) {
    const occurredAt =
      typeof entry.time === 'number' ? new Date(entry.time * 1000).toISOString() : null;

    for (const change of entry.changes ?? []) {
      const base = classify(change.field);
      const kind = change.field === 'permissions' ? refinePermissions(change.value) : base;

      events.push({
        externalEventId: null,
        kind,
        eventType: `${object}.${change.field ?? 'unknown'}`,
        externalAccountId: entry.id ?? null,
        externalObjectId: readObjectId(change.value),
        occurredAt,
        payload: { object, field: change.field, value: change.value },
      });
    }

    // An entry with no `changes` still happened. Recording it as `unrecognized` keeps the
    // forensic trail complete without pretending we understood it.
    if ((entry.changes ?? []).length === 0) {
      events.push({
        externalEventId: null,
        kind: 'unrecognized',
        eventType: `${object}.entry`,
        externalAccountId: entry.id ?? null,
        externalObjectId: null,
        occurredAt,
        payload: entry as unknown,
      });
    }
  }

  return events;
}

function readObjectId(value: Record<string, unknown> | undefined): string | null {
  if (!value) return null;
  for (const key of ['post_id', 'media_id', 'comment_id', 'id']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * The whole Meta webhook flow, shared by all three adapters.
 *
 * `object` differs per platform (`page`, `instagram`, `threads`) and is what distinguishes
 * an Instagram comment from a Facebook one in the stored event type.
 */
export async function handleMetaWebhook(
  request: ProviderWebhookRequest,
  object: string,
): Promise<ProviderWebhookResult> {
  if (request.method === 'GET') return metaHandshake(request);

  if (!request.app) {
    return {
      kind: 'events',
      verified: false,
      reason: 'no_provider_app_configured',
      events: [],
    };
  }

  const verified = await verifyMetaSignature(
    request.app.clientSecret,
    request.rawBody,
    request.headers[SIGNATURE_HEADER],
  );

  if (!verified) {
    return { kind: 'events', verified: false, reason: 'signature_mismatch', events: [] };
  }

  return { kind: 'events', verified: true, events: parseMetaEvents(request.rawBody, object) };
}
