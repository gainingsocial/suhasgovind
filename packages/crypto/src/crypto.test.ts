import { describe, expect, it } from 'vitest';

import {
  apiKeyLookupPrefix,
  generateApiKey,
  hashApiKey,
  isWellFormedApiKey,
  parseApiKeyEnvironment,
  redactApiKey,
  verifyApiKey,
} from './api-keys.js';
import {
  CredentialCipher,
  CredentialDecryptionError,
  CryptoConfigurationError,
  Keyring,
} from './credential-cipher.js';
import type { CredentialContext } from './credential-cipher.js';
import { bytesToBase64, randomBytes, timingSafeEqual, utf8ToBytes } from './encoding.js';
import { TOKEN_PURPOSE, issueSignedToken, verifySignedToken } from './signed-token.js';
import {
  deriveWebhookSecret,
  signWebhookPayload,
  verifyProviderHmacSignature,
  verifyWebhookSignature,
} from './webhook-signing.js';

const key = (seed: number) => bytesToBase64(new Uint8Array(32).fill(seed));

const context: CredentialContext = {
  organizationId: 'org_1',
  projectId: 'prj_1',
  connectionId: 'con_1',
  credentialType: 'access_token',
};

describe('Keyring', () => {
  it('rejects key material that is not 32 bytes', () => {
    expect(() => new Keyring([{ version: 1, material: bytesToBase64(new Uint8Array(16)) }], 1)).toThrow(
      CryptoConfigurationError,
    );
  });

  it('rejects an active version that is not in the ring', () => {
    expect(() => new Keyring([{ version: 1, material: key(1) }], 2)).toThrow(CryptoConfigurationError);
  });

  it('builds from CREDENTIAL_KEK_V{n} environment variables', () => {
    const ring = Keyring.fromEnv({
      CREDENTIAL_KEK_V1: key(1),
      CREDENTIAL_KEK_V2: key(2),
      CREDENTIAL_KEK_ACTIVE_VERSION: '2',
      UNRELATED_SECRET: 'ignored',
    });

    expect(ring.versions).toEqual([1, 2]);
    expect(ring.activeVersion).toBe(2);
  });

  it('defaults the active version to the highest present', () => {
    const ring = Keyring.fromEnv({ CREDENTIAL_KEK_V1: key(1), CREDENTIAL_KEK_V3: key(3) });
    expect(ring.activeVersion).toBe(3);
  });

  it('fails loudly when no key is configured rather than silently disabling encryption', () => {
    expect(() => Keyring.fromEnv({})).toThrow(CryptoConfigurationError);
  });
});

describe('CredentialCipher', () => {
  const cipher = new CredentialCipher(new Keyring([{ version: 1, material: key(1) }], 1));

  it('round-trips a token', async () => {
    const record = await cipher.encrypt('refresh-token-value', context);

    expect(record.algorithm).toBe('AES-256-GCM');
    expect(record.keyVersion).toBe(1);
    expect(record.ciphertext).not.toContain('refresh-token-value');
    expect(await cipher.decrypt(record, context)).toBe('refresh-token-value');
  });

  it('produces a distinct ciphertext each time for identical plaintext', async () => {
    // A fresh random nonce per record. Identical ciphertexts would let an observer with
    // read access to the table learn that two connections share a credential.
    const a = await cipher.encrypt('same', context);
    const b = await cipher.encrypt('same', context);

    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('refuses to decrypt under a different tenant context', async () => {
    // ADR-007: AAD binding turns a confused-deputy attack into a crypto failure.
    const record = await cipher.encrypt('secret', context);

    await expect(
      cipher.decrypt(record, { ...context, organizationId: 'org_attacker' }),
    ).rejects.toThrow(CredentialDecryptionError);
  });

  it('refuses to decrypt when moved to a different connection', async () => {
    const record = await cipher.encrypt('secret', context);

    await expect(cipher.decrypt(record, { ...context, connectionId: 'con_other' })).rejects.toThrow(
      CredentialDecryptionError,
    );
  });

  it('refuses to decrypt when the credential slot changes', async () => {
    const record = await cipher.encrypt('secret', context);

    await expect(
      cipher.decrypt({ ...record }, { ...context, credentialType: 'refresh_token' }),
    ).rejects.toThrow(CredentialDecryptionError);
  });

  it('detects tampering with the ciphertext', async () => {
    const record = await cipher.encrypt('secret', context);
    const tampered = { ...record, ciphertext: `${record.ciphertext.slice(0, -4)}AAAA` };

    await expect(cipher.decrypt(tampered, context)).rejects.toThrow(CredentialDecryptionError);
  });

  it('does not leak plaintext through the decryption error', async () => {
    const record = await cipher.encrypt('hunter2', context);

    await expect(
      cipher.decrypt(record, { ...context, projectId: 'prj_other' }),
    ).rejects.toThrow(/could not be decrypted/i);
  });

  it('reads records written under an older key version', async () => {
    const v1 = new CredentialCipher(new Keyring([{ version: 1, material: key(1) }], 1));
    const record = await v1.encrypt('legacy-token', context);

    const rotated = new CredentialCipher(
      new Keyring(
        [
          { version: 1, material: key(1) },
          { version: 2, material: key(2) },
        ],
        2,
      ),
    );

    expect(await rotated.decrypt(record, context)).toBe('legacy-token');
    expect(rotated.needsRotation(record)).toBe(true);
  });

  it('re-encrypts under the active key version on rotation', async () => {
    const ring = new Keyring(
      [
        { version: 1, material: key(1) },
        { version: 2, material: key(2) },
      ],
      2,
    );
    const v1Only = new CredentialCipher(new Keyring([{ version: 1, material: key(1) }], 1));
    const rotator = new CredentialCipher(ring);

    const old = await v1Only.encrypt('token', context);
    const fresh = await rotator.rotate(old, context);

    expect(fresh.keyVersion).toBe(2);
    expect(rotator.needsRotation(fresh)).toBe(false);
    expect(await rotator.decrypt(fresh, context)).toBe('token');
  });

  it('reports a missing key version instead of failing silently', async () => {
    const record = { ciphertext: 'AAAA', nonce: 'AAAAAAAAAAAAAAAA', algorithm: 'AES-256-GCM' as const, keyVersion: 9 };

    await expect(cipher.decrypt(record, context)).rejects.toThrow(CryptoConfigurationError);
  });
});

describe('API keys', () => {
  const pepper = 'test-pepper';

  it('generates a key with the right environment marker and a stored prefix', async () => {
    const live = await generateApiKey('live', pepper);
    const test = await generateApiKey('test', pepper);

    expect(live.raw.startsWith('sk_live_')).toBe(true);
    expect(test.raw.startsWith('sk_test_')).toBe(true);
    expect(live.prefix).toBe(live.raw.slice(0, 16));
    expect(live.raw).not.toBe(live.hash);
  });

  it('never stores anything from which the raw key can be recovered', async () => {
    const generated = await generateApiKey('live', pepper);
    const secretPart = generated.raw.slice(16);

    expect(generated.hash).not.toContain(secretPart);
    expect(generated.prefix).not.toContain(secretPart);
  });

  it('verifies a correct key and rejects a wrong one', async () => {
    const generated = await generateApiKey('live', pepper);

    expect(await verifyApiKey(generated.raw, generated.hash, pepper)).toBe(true);
    expect(await verifyApiKey(`${generated.raw}x`, generated.hash, pepper)).toBe(false);
  });

  it('rejects a valid key hashed under a different pepper', async () => {
    // The pepper is what stops an attacker with only a database dump from verifying guesses.
    const generated = await generateApiKey('live', pepper);
    expect(await verifyApiKey(generated.raw, generated.hash, 'other-pepper')).toBe(false);
  });

  it('produces a stable hash for the same key', async () => {
    const generated = await generateApiKey('test', pepper);
    expect(await hashApiKey(generated.raw, pepper)).toBe(generated.hash);
  });

  it('parses the environment and rejects malformed keys', () => {
    expect(parseApiKeyEnvironment('sk_live_abc')).toBe('live');
    expect(parseApiKeyEnvironment('sk_test_abc')).toBe('test');
    expect(parseApiKeyEnvironment('pk_live_abc')).toBeNull();

    expect(isWellFormedApiKey('sk_live_' + 'a'.repeat(43))).toBe(true);
    expect(isWellFormedApiKey('sk_live_short')).toBe(false);
    expect(isWellFormedApiKey('bearer token')).toBe(false);
    expect(isWellFormedApiKey('sk_live_' + 'a'.repeat(40) + '!!!')).toBe(false);
  });

  it('redacts to the lookup prefix only', async () => {
    const generated = await generateApiKey('live', pepper);
    const redacted = redactApiKey(generated.raw);

    expect(redacted).toBe(`${apiKeyLookupPrefix(generated.raw)}…`);
    expect(redacted.length).toBeLessThan(20);
  });
});

describe('webhook signing', () => {
  const root = randomBytes(32);

  it('derives a stable per-endpoint secret from the root', async () => {
    const a = await deriveWebhookSecret(root, 'wh_1', 1);
    const b = await deriveWebhookSecret(root, 'wh_1', 1);
    const other = await deriveWebhookSecret(root, 'wh_2', 1);
    const rotated = await deriveWebhookSecret(root, 'wh_1', 2);

    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a).not.toBe(rotated);
    expect(a.startsWith('whsec_')).toBe(true);
  });

  it('verifies a signature it produced', async () => {
    const secret = await deriveWebhookSecret(root, 'wh_1', 1);
    const body = JSON.stringify({ type: 'post.published', data: { id: 'pst_1' } });
    const timestamp = 1_754_000_000;

    const signature = await signWebhookPayload(secret, timestamp, body);

    expect(
      await verifyWebhookSignature({
        secret,
        rawBody: body,
        signatureHeader: signature,
        timestampHeader: String(timestamp),
        nowSeconds: timestamp + 10,
      }),
    ).toEqual({ valid: true });
  });

  it('rejects a body modified after signing', async () => {
    const secret = await deriveWebhookSecret(root, 'wh_1', 1);
    const timestamp = 1_754_000_000;
    const signature = await signWebhookPayload(secret, timestamp, '{"amount":1}');

    const result = await verifyWebhookSignature({
      secret,
      rawBody: '{"amount":1000}',
      signatureHeader: signature,
      timestampHeader: String(timestamp),
      nowSeconds: timestamp,
    });

    expect(result).toEqual({ valid: false, reason: 'no_matching_signature' });
  });

  it('rejects a replayed delivery outside the tolerance window', async () => {
    const secret = await deriveWebhookSecret(root, 'wh_1', 1);
    const body = '{}';
    const timestamp = 1_754_000_000;
    const signature = await signWebhookPayload(secret, timestamp, body);

    const result = await verifyWebhookSignature({
      secret,
      rawBody: body,
      signatureHeader: signature,
      timestampHeader: String(timestamp),
      nowSeconds: timestamp + 3600,
    });

    expect(result).toEqual({ valid: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects a malformed timestamp header', async () => {
    const result = await verifyWebhookSignature({
      secret: 'whsec_x',
      rawBody: '{}',
      signatureHeader: 'v1=deadbeef',
      timestampHeader: 'not-a-number',
    });

    expect(result).toEqual({ valid: false, reason: 'malformed_timestamp' });
  });

  it('accepts either signature during a secret rotation overlap', async () => {
    const oldSecret = await deriveWebhookSecret(root, 'wh_1', 1);
    const newSecret = await deriveWebhookSecret(root, 'wh_1', 2);
    const body = '{"a":1}';
    const timestamp = 1_754_000_000;

    const header = [
      await signWebhookPayload(oldSecret, timestamp, body),
      await signWebhookPayload(newSecret, timestamp, body),
    ].join(' ');

    for (const secret of [oldSecret, newSecret]) {
      expect(
        await verifyWebhookSignature({
          secret,
          rawBody: body,
          signatureHeader: header,
          timestampHeader: String(timestamp),
          nowSeconds: timestamp,
        }),
      ).toEqual({ valid: true });
    }
  });

  it('verifies an inbound provider sha256= signature', async () => {
    const secret = 'provider-app-secret';
    const body = '{"entry":[]}';
    const signed = await signWebhookPayload(secret, 0, body);
    const hexOnly = signed.slice('v1='.length);

    // Provider signs the raw body with no timestamp prefix, so recompute directly.
    const { hmacSha256Hex } = await import('./hmac.js');
    const expected = await hmacSha256Hex(secret, body);

    expect(await verifyProviderHmacSignature({ secret, rawBody: body, signatureHeader: `sha256=${expected}` })).toBe(true);
    expect(await verifyProviderHmacSignature({ secret, rawBody: body, signatureHeader: `sha256=${hexOnly}` })).toBe(false);
    expect(await verifyProviderHmacSignature({ secret, rawBody: '{"entry":[1]}', signatureHeader: `sha256=${expected}` })).toBe(false);
  });
});

describe('signed tokens', () => {
  const secret = randomBytes(32);

  it('round-trips claims', async () => {
    const token = await issueSignedToken({
      secret,
      purpose: TOKEN_PURPOSE.connectSession,
      subject: 'cs_123',
      ttlSeconds: 900,
      data: { profile_id: 'pro_1' },
      nowSeconds: 1000,
    });

    const result = await verifySignedToken({
      secret,
      token,
      expectedPurpose: TOKEN_PURPOSE.connectSession,
      nowSeconds: 1100,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.sub).toBe('cs_123');
      expect(result.claims.data).toEqual({ profile_id: 'pro_1' });
      expect(result.claims.exp).toBe(1900);
    }
  });

  it('rejects a token signed with a different key', async () => {
    const token = await issueSignedToken({
      secret,
      purpose: TOKEN_PURPOSE.connectSession,
      subject: 'cs_1',
      ttlSeconds: 60,
      nowSeconds: 0,
    });

    const result = await verifySignedToken({
      secret: randomBytes(32),
      token,
      expectedPurpose: TOKEN_PURPOSE.connectSession,
      nowSeconds: 1,
    });

    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a tampered payload even when claims look plausible', async () => {
    const token = await issueSignedToken({
      secret,
      purpose: TOKEN_PURPOSE.connectSession,
      subject: 'cs_1',
      ttlSeconds: 60,
      nowSeconds: 0,
    });

    const forged = await issueSignedToken({
      secret: randomBytes(32),
      purpose: TOKEN_PURPOSE.connectSession,
      subject: 'cs_victim',
      ttlSeconds: 60,
      nowSeconds: 0,
    });

    const spliced = `${forged.split('.')[0]}.${token.split('.')[1]}`;
    const result = await verifySignedToken({
      secret,
      token: spliced,
      expectedPurpose: TOKEN_PURPOSE.connectSession,
      nowSeconds: 1,
    });

    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects an expired token', async () => {
    const token = await issueSignedToken({
      secret,
      purpose: TOKEN_PURPOSE.connectSession,
      subject: 'cs_1',
      ttlSeconds: 900,
      nowSeconds: 0,
    });

    const result = await verifySignedToken({
      secret,
      token,
      expectedPurpose: TOKEN_PURPOSE.connectSession,
      nowSeconds: 900,
    });

    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('refuses to redeem a token minted for another purpose', async () => {
    const token = await issueSignedToken({
      secret,
      purpose: TOKEN_PURPOSE.mediaUpload,
      subject: 'med_1',
      ttlSeconds: 900,
      nowSeconds: 0,
    });

    const result = await verifySignedToken({
      secret,
      token,
      expectedPurpose: TOKEN_PURPOSE.connectSession,
      nowSeconds: 1,
    });

    expect(result).toEqual({ valid: false, reason: 'purpose_mismatch' });
  });

  it('rejects structurally malformed tokens', async () => {
    for (const token of ['', 'nodot', 'a.b.c']) {
      expect(
        await verifySignedToken({ secret, token, expectedPurpose: TOKEN_PURPOSE.connectSession }),
      ).toEqual({ valid: false, reason: 'malformed' });
    }
  });
});

describe('timingSafeEqual', () => {
  it('compares equal and unequal buffers correctly', () => {
    expect(timingSafeEqual(utf8ToBytes('abc'), utf8ToBytes('abc'))).toBe(true);
    expect(timingSafeEqual(utf8ToBytes('abc'), utf8ToBytes('abd'))).toBe(false);
    expect(timingSafeEqual(utf8ToBytes('abc'), utf8ToBytes('abcd'))).toBe(false);
  });
});
