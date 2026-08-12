import { fromPublicId } from '@gs/contracts/ids';
import { isProviderName } from '@gs/contracts/providers';
import { decodeSecret, deriveProviderVerifyToken, sha256Hex } from '@gs/crypto';
import type { CREDENTIAL_ALGORITHM } from '@gs/crypto';
import {
  findProviderApp,
  loadProviderAppWithCredentials,
  recordProviderEvent,
  type Database,
  type ProviderApp,
} from '@gs/db';
import type { Logger } from '@gs/observability';
import {
  callbackUrlFor,
  credentialCipher,
  providerAppCredentialContext,
} from '@gs/platform-credentials';
import type { ProviderAppCredentials, ProviderWebhookResult } from '@gs/provider-kit';
import { getAdapter, hasAdapter } from '@gs/providers';

import type { Env, ProviderEventMessage } from './env.js';

/**
 * Provider webhook ingress (plan §34).
 *
 * The order is fixed and the reasoning behind it is the whole design:
 *
 *   1. verify the signature
 *   2. persist the event, deduplicated
 *   3. enqueue processing
 *   4. acknowledge
 *
 * Nothing heavy happens before step 4. Providers ack-or-retry on short deadlines, and a
 * handler that resolves connections and updates health inline turns one slow database
 * query into a redelivery storm — during exactly the incident that produced the webhook.
 */

/** Anything larger is not a webhook we recognize; reading it would be a free memory DoS. */
const MAX_BODY_BYTES = 1_000_000;

export interface IngressOutcome {
  status: number;
  body: string;
  contentType: string;
  /** Messages to enqueue after the response is committed. */
  enqueue: ProviderEventMessage[];
}

/**
 * A plain 200 with an empty body.
 *
 * Used for verification failures too. Returning 401 to an unsigned request tells whoever
 * sent it that the endpoint exists, is live, and which secret they failed to guess —
 * information worth more to an attacker than the rejection costs them.
 */
function acknowledged(): IngressOutcome {
  return { status: 200, body: '', contentType: 'text/plain', enqueue: [] };
}

/**
 * Resolve which registered application signed this delivery.
 *
 * A webhook arrives with no tenant context, so the platform-managed app is the default. An
 * enterprise using their own Meta or LinkedIn app registers the app-scoped path
 * (`/webhooks/providers/meta/app_...`) in their own console, because their deliveries are
 * signed with their secret and the platform default would reject every one of them.
 */
async function resolveSigningApp(
  db: Database,
  provider: string,
  appPublicId: string | null,
): Promise<ProviderApp | null> {
  if (appPublicId) {
    const internalId = fromPublicId('providerApp', appPublicId);
    if (!internalId) return null;
    const row = await loadProviderAppWithCredentials(db, internalId);
    // A mismatched provider means the URL was hand-edited. Refusing beats verifying a
    // Meta payload against a LinkedIn secret and reporting a signature failure.
    return row && row.provider === provider ? row : null;
  }
  return findProviderApp(db, provider, null);
}

async function appCredentials(
  env: Env,
  row: ProviderApp,
): Promise<ProviderAppCredentials | null> {
  if (!row.clientId || !row.encryptedClientSecret) return null;

  const clientSecret = await credentialCipher(env).decrypt(
    {
      ciphertext: row.encryptedClientSecret.ciphertext,
      nonce: row.encryptedClientSecret.nonce,
      algorithm: row.encryptedClientSecret.algorithm as typeof CREDENTIAL_ALGORITHM,
      keyVersion: row.encryptedClientSecret.keyVersion,
    },
    providerAppCredentialContext(row),
  );

  return {
    clientId: row.clientId,
    clientSecret,
    redirectUri: callbackUrlFor(env.PUBLIC_API_ORIGIN ?? '', row.provider),
    metadata: (row.callbackConfig ?? {}) as Record<string, unknown>,
  };
}

/**
 * The token a provider echoes during subscription setup.
 *
 * An explicitly configured value wins, because a provider console may already hold one
 * from a previous setup and changing it there breaks a live subscription. Otherwise it is
 * derived, so an operator never has to invent one and the Platforms page can display it.
 */
async function verifyTokenFor(env: Env, row: ProviderApp): Promise<string | null> {
  const configured = (row.callbackConfig as Record<string, unknown> | null)?.[
    'webhook_verify_token'
  ];
  if (typeof configured === 'string' && configured.length > 0) return configured;

  if (!env.WEBHOOK_SIGNING_ROOT) return null;
  return deriveProviderVerifyToken(
    decodeSecret('WEBHOOK_SIGNING_ROOT', env.WEBHOOK_SIGNING_ROOT),
    row.provider,
    row.id,
  );
}

/**
 * Handle one inbound delivery.
 *
 * Never throws. A provider reads a 5xx as "retry this", so an unexpected failure here
 * would convert a bug of ours into sustained inbound traffic we also cannot process.
 */
export async function handleIngress(
  db: Database,
  env: Env,
  request: Request,
  logger: Logger,
  traceId: string,
): Promise<IngressOutcome> {
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);

  // /webhooks/providers/{provider}[/{appPublicId}]
  if (segments[0] !== 'webhooks' || segments[1] !== 'providers') {
    return { status: 404, body: '', contentType: 'text/plain', enqueue: [] };
  }

  const provider = segments[2];
  const appPublicId = segments[3] ?? null;

  if (!provider || !isProviderName(provider) || !hasAdapter(provider)) {
    return { status: 404, body: '', contentType: 'text/plain', enqueue: [] };
  }

  const adapter = getAdapter(provider);
  if (!adapter.verifyWebhook) {
    // The provider has no webhook integration certified yet. 404 rather than 501: an
    // endpoint that exists but cannot verify anything is a worse answer than one that
    // does not exist, and a provider will keep retrying a 5xx forever.
    logger.warn('provider_webhook.unsupported', { provider });
    return { status: 404, body: '', contentType: 'text/plain', enqueue: [] };
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    logger.warn('provider_webhook.oversized', { provider, bytes: raw.length });
    return acknowledged();
  }

  const appRow = await resolveSigningApp(db, provider, appPublicId);
  const app = appRow ? await appCredentials(env, appRow) : null;
  const verifyToken = appRow ? await verifyTokenFor(env, appRow) : null;

  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;

  let result: ProviderWebhookResult;
  try {
    result = await adapter.verifyWebhook({
      method: request.method,
      url: request.url,
      headers,
      rawBody: raw,
      app,
      verifyToken,
    });
  } catch (error) {
    logger.error('provider_webhook.verify_threw', {
      provider,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return acknowledged();
  }

  if (result.kind === 'handshake') {
    logger.info('provider_webhook.handshake', { provider, status: result.status });
    return {
      status: result.status,
      body: result.body,
      contentType: result.contentType,
      enqueue: [],
    };
  }

  if (!result.verified) {
    /**
     * Recorded, not processed. A burst of signature failures is the signal that a secret
     * was rotated on the provider's side without being rotated here — which otherwise
     * presents as webhooks that simply stopped arriving, with no error anywhere.
     */
    await recordProviderEvent(db, {
      provider,
      providerEventId: null,
      fingerprint: await fingerprint(provider, raw),
      eventType: 'signature_rejected',
      signatureVerified: false,
      payload: { reason: result.reason ?? 'unknown' },
      traceId,
    });
    logger.warn('provider_webhook.rejected', { provider, reason: result.reason });
    return acknowledged();
  }

  const enqueue: ProviderEventMessage[] = [];

  for (const event of result.events) {
    const recorded = await recordProviderEvent(db, {
      provider,
      providerEventId: event.externalEventId,
      // Only when the provider gives us nothing stable to key on (plan §10.4). Setting
      // both would let one event be stored twice under two different dedupe keys.
      fingerprint: event.externalEventId ? null : await fingerprint(provider, JSON.stringify(event)),
      eventType: event.eventType,
      signatureVerified: true,
      payload: event as unknown as Record<string, unknown>,
      traceId,
    });

    if (recorded.duplicate) {
      logger.info('provider_webhook.duplicate', { provider, eventType: event.eventType });
      continue;
    }

    enqueue.push({
      type: 'provider.event',
      providerEventId: recorded.id,
      provider,
      traceId,
    });
  }

  logger.info('provider_webhook.accepted', {
    provider,
    received: result.events.length,
    enqueued: enqueue.length,
  });

  return { status: 200, body: '', contentType: 'text/plain', enqueue };
}

/**
 * Dedupe key for a provider that supplies no event id.
 *
 * Hashing the normalized event rather than the whole request body: one Meta POST carries
 * many changes, and keying on the body would make a batch containing one already-seen
 * change look entirely new.
 */
async function fingerprint(provider: string, material: string): Promise<string> {
  return sha256Hex(`${provider}|${material}`);
}
