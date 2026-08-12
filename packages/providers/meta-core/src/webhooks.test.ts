import { hmacSha256Hex } from '@gs/provider-kit';
import type { ProviderAppCredentials, ProviderWebhookRequest } from '@gs/provider-kit';
import { describe, expect, it } from 'vitest';

import { handleMetaWebhook, parseMetaEvents, verifyMetaSignature } from './webhooks.js';

/**
 * Meta webhook protocol tests (plan §34).
 *
 * Verified against the documented behaviour in
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started (Rule 2).
 */

const APP_SECRET = 'test-app-secret';

const app: ProviderAppCredentials = {
  clientId: '1234567890',
  clientSecret: APP_SECRET,
  redirectUri: 'https://api.gainingsocial.com/v1/oauth/facebook/callback',
  metadata: {},
};

async function signed(body: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(APP_SECRET, body)}`;
}

function post(body: string, signature: string | null): ProviderWebhookRequest {
  return {
    method: 'POST',
    url: 'https://api.gainingsocial.com/webhooks/providers/facebook',
    headers: signature ? { 'x-hub-signature-256': signature } : {},
    rawBody: body,
    app,
    verifyToken: 'verify-me',
  };
}

describe('meta webhook signature', () => {
  it('accepts a correctly signed body', async () => {
    const body = '{"object":"page","entry":[]}';
    expect(await verifyMetaSignature(APP_SECRET, body, await signed(body))).toBe(true);
  });

  it('rejects a body that was modified after signing', async () => {
    const signature = await signed('{"object":"page","entry":[]}');
    expect(await verifyMetaSignature(APP_SECRET, '{"object":"page","entry":[1]}', signature)).toBe(
      false,
    );
  });

  it('rejects a signature computed with a different app secret', async () => {
    const body = '{"object":"page"}';
    const wrong = `sha256=${await hmacSha256Hex('someone-elses-secret', body)}`;
    expect(await verifyMetaSignature(APP_SECRET, body, wrong)).toBe(false);
  });

  it('rejects a missing header rather than treating absence as valid', async () => {
    expect(await verifyMetaSignature(APP_SECRET, '{}', undefined)).toBe(false);
  });

  it('rejects a signature without the sha256= prefix', async () => {
    const body = '{}';
    const bare = await hmacSha256Hex(APP_SECRET, body);
    expect(await verifyMetaSignature(APP_SECRET, body, bare)).toBe(false);
  });
});

describe('meta subscription handshake', () => {
  const handshake = (params: string): ProviderWebhookRequest => ({
    method: 'GET',
    url: `https://api.gainingsocial.com/webhooks/providers/facebook?${params}`,
    headers: {},
    rawBody: '',
    app,
    verifyToken: 'verify-me',
  });

  it('echoes the challenge when the verify token matches', async () => {
    const result = await handleMetaWebhook(
      handshake('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444'),
      'page',
    );

    expect(result).toEqual({
      kind: 'handshake',
      status: 200,
      body: '1158201444',
      contentType: 'text/plain',
    });
  });

  it('refuses a handshake carrying the wrong verify token', async () => {
    const result = await handleMetaWebhook(
      handshake('hub.mode=subscribe&hub.verify_token=guessed&hub.challenge=1158201444'),
      'page',
    );

    expect(result).toMatchObject({ kind: 'handshake', status: 403, body: '' });
  });

  it('refuses a handshake when no verify token is configured on our side', async () => {
    const result = await handleMetaWebhook(
      {
        ...handshake('hub.mode=subscribe&hub.verify_token=&hub.challenge=99'),
        verifyToken: null,
      },
      'page',
    );

    expect(result).toMatchObject({ kind: 'handshake', status: 403 });
  });
});

describe('meta event parsing', () => {
  it('carves one batched POST into one event per change', () => {
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: '111222333',
          time: 1_700_000_000,
          changes: [
            { field: 'comments', value: { comment_id: 'c_1' } },
            { field: 'name', value: { name: 'New Page Name' } },
          ],
        },
      ],
    });

    const events = parseMetaEvents(body, 'page');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'engagement',
      eventType: 'page.comments',
      externalAccountId: '111222333',
      externalObjectId: 'c_1',
      externalEventId: null,
    });
    expect(events[1]).toMatchObject({ kind: 'account_updated', eventType: 'page.name' });
  });

  it('converts Meta seconds to a UTC ISO-8601 timestamp (Rule 15)', () => {
    const body = JSON.stringify({
      object: 'page',
      entry: [{ id: '1', time: 1_700_000_000, changes: [{ field: 'comments', value: {} }] }],
    });

    expect(parseMetaEvents(body, 'page')[0]?.occurredAt).toBe('2023-11-14T22:13:20.000Z');
  });

  it('classifies a full permission revocation as authorization_revoked', () => {
    const body = JSON.stringify({
      object: 'user',
      entry: [
        {
          id: '555',
          time: 1_700_000_000,
          changes: [
            {
              field: 'permissions',
              value: { permissions: [{ permission: 'public_profile', status: 'revoked' }] },
            },
          ],
        },
      ],
    });

    expect(parseMetaEvents(body, 'user')[0]?.kind).toBe('authorization_revoked');
  });

  it('treats losing one scope as permissions_changed, not a full revocation', () => {
    const body = JSON.stringify({
      object: 'user',
      entry: [
        {
          id: '555',
          time: 1_700_000_000,
          changes: [
            {
              field: 'permissions',
              value: { permissions: [{ permission: 'pages_manage_posts', status: 'revoked' }] },
            },
          ],
        },
      ],
    });

    expect(parseMetaEvents(body, 'user')[0]?.kind).toBe('permissions_changed');
  });

  it('records an unknown field as unrecognized rather than guessing at it (Rule 14)', () => {
    const body = JSON.stringify({
      object: 'page',
      entry: [{ id: '1', time: 1, changes: [{ field: 'some_future_field', value: {} }] }],
    });

    expect(parseMetaEvents(body, 'page')[0]?.kind).toBe('unrecognized');
  });

  it('keeps an entry that carries no changes, so the forensic trail stays complete', () => {
    const body = JSON.stringify({ object: 'page', entry: [{ id: '1', time: 1 }] });

    expect(parseMetaEvents(body, 'page')).toMatchObject([
      { kind: 'unrecognized', eventType: 'page.entry', externalAccountId: '1' },
    ]);
  });

  it('returns nothing for a body that is not JSON, rather than throwing into the ingress', () => {
    expect(parseMetaEvents('not json at all', 'page')).toEqual([]);
  });
});

describe('handleMetaWebhook', () => {
  it('parses events when the signature verifies', async () => {
    const body = JSON.stringify({
      object: 'page',
      entry: [{ id: '9', time: 1, changes: [{ field: 'comments', value: {} }] }],
    });

    const result = await handleMetaWebhook(post(body, await signed(body)), 'page');

    expect(result).toMatchObject({ kind: 'events', verified: true });
    expect(result.kind === 'events' && result.events).toHaveLength(1);
  });

  it('returns no events at all when the signature fails', async () => {
    const body = JSON.stringify({
      object: 'page',
      entry: [{ id: '9', time: 1, changes: [{ field: 'comments', value: {} }] }],
    });

    const result = await handleMetaWebhook(post(body, 'sha256=deadbeef'), 'page');

    expect(result).toMatchObject({
      kind: 'events',
      verified: false,
      reason: 'signature_mismatch',
      events: [],
    });
  });

  it('refuses to verify when no app is configured instead of skipping the check', async () => {
    const body = '{"object":"page","entry":[]}';
    const result = await handleMetaWebhook({ ...post(body, await signed(body)), app: null }, 'page');

    expect(result).toMatchObject({
      kind: 'events',
      verified: false,
      reason: 'no_provider_app_configured',
    });
  });
});
