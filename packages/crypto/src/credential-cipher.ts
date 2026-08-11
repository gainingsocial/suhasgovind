import { base64ToBytes, bytesToBase64, bytesToUtf8, randomBytes, utf8ToBytes } from './encoding.js';

/**
 * Application-layer encryption for provider credentials (plan §7.1, ADR-007).
 *
 * Threat model this defends against: a read-only compromise of PostgreSQL — a leaked
 * backup, an over-broad SELECT, a support query, a future analytics job. The root key
 * lives in Cloudflare Secrets Store, never in the database, so ciphertext alone is inert.
 *
 * This is textbook AES-256-GCM rather than anything clever. Key separation between
 * tenants comes from the Associated Authenticated Data binding below, not from a bespoke
 * key-derivation scheme — novel crypto constructions are a liability at this layer.
 */

export const CREDENTIAL_ALGORITHM = 'AES-256-GCM' as const;

/** GCM's standard nonce length. 96 bits is the only size with a security proof for GCM. */
const NONCE_LENGTH = 12;
const KEY_LENGTH = 32;

/** The stored shape. Mirrors the `social_credentials` columns in plan §7.1. */
export interface EncryptedRecord {
  ciphertext: string;
  nonce: string;
  algorithm: typeof CREDENTIAL_ALGORITHM;
  keyVersion: number;
}

/**
 * Context bound into the ciphertext as AAD.
 *
 * Because these values are authenticated, copying a ciphertext row to another tenant,
 * another connection or another credential slot makes decryption fail. A confused-deputy
 * attack becomes a crypto error instead of a silent credential swap.
 */
export interface CredentialContext {
  organizationId: string;
  projectId: string;
  connectionId: string;
  credentialType: string;
  /**
   * Set only for a credential belonging to one publishable surface (a Meta Page token).
   * Without it, two Pages under the same connection would share an AAD and their tokens
   * could be swapped undetected — publishing to the wrong Page with a valid signature.
   *
   * Appended rather than inserted, so a connection-level record produces byte-identical
   * AAD to what it was written with before this field existed.
   */
  destinationId?: string | null;
}

export interface KeyringEntry {
  version: number;
  /** Base64-encoded 32 raw bytes. */
  material: string;
}

export class CryptoConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoConfigurationError';
  }
}

export class CredentialDecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CredentialDecryptionError';
  }
}

/**
 * Canonical AAD string. The field order is fixed and part of the on-disk format —
 * changing it makes every existing ciphertext undecryptable, so it must never be
 * reordered without a re-encryption migration.
 */
function canonicalAad(context: CredentialContext): Uint8Array {
  const parts = [
    'gs.credential.v1',
    context.organizationId,
    context.projectId,
    context.connectionId,
    context.credentialType,
  ];

  // Appended only when present. A connection-level credential therefore hashes exactly as
  // it did before destination-scoped credentials existed, so no re-encryption is needed.
  if (context.destinationId) parts.push(context.destinationId);

  return utf8ToBytes(parts.join('|'));
}

/**
 * Holds every key version the application can read, and the one version it writes with.
 *
 * Rotation (ADR-007): add version n+1 as active, keep n readable, re-encrypt lazily as
 * credentials refresh, then retire n once drained.
 */
export class Keyring {
  private readonly keys = new Map<number, Promise<CryptoKey>>();
  readonly activeVersion: number;

  constructor(entries: readonly KeyringEntry[], activeVersion: number) {
    if (entries.length === 0) {
      throw new CryptoConfigurationError('Keyring requires at least one key version.');
    }

    for (const entry of entries) {
      const raw = base64ToBytes(entry.material);
      if (raw.length !== KEY_LENGTH) {
        throw new CryptoConfigurationError(
          `Key version ${entry.version} must be ${KEY_LENGTH} raw bytes (base64-encoded); got ${raw.length}.`,
        );
      }
      this.keys.set(
        entry.version,
        crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
          'encrypt',
          'decrypt',
        ]),
      );
    }

    if (!this.keys.has(activeVersion)) {
      throw new CryptoConfigurationError(
        `Active key version ${activeVersion} is not present in the keyring.`,
      );
    }
    this.activeVersion = activeVersion;
  }

  /**
   * Build a keyring from environment variables named `CREDENTIAL_KEK_V{n}`, with the
   * active version in `CREDENTIAL_KEK_ACTIVE_VERSION`.
   */
  static fromEnv(env: Record<string, string | undefined>): Keyring {
    const entries: KeyringEntry[] = [];
    for (const [name, value] of Object.entries(env)) {
      const match = /^CREDENTIAL_KEK_V(\d+)$/.exec(name);
      if (match && value) {
        entries.push({ version: Number(match[1]), material: value });
      }
    }

    if (entries.length === 0) {
      throw new CryptoConfigurationError(
        'No CREDENTIAL_KEK_V{n} secret is configured. Provider credentials cannot be read or written.',
      );
    }

    const declared = env.CREDENTIAL_KEK_ACTIVE_VERSION;
    const activeVersion = declared
      ? Number(declared)
      : Math.max(...entries.map((entry) => entry.version));

    if (!Number.isInteger(activeVersion)) {
      throw new CryptoConfigurationError(
        `CREDENTIAL_KEK_ACTIVE_VERSION must be an integer; got "${declared}".`,
      );
    }

    return new Keyring(entries, activeVersion);
  }

  async key(version: number): Promise<CryptoKey> {
    const key = this.keys.get(version);
    if (!key) {
      // A credential encrypted under a retired key version. Recoverable only by
      // restoring that key — surfaced loudly rather than silently failing to publish.
      throw new CryptoConfigurationError(
        `Key version ${version} is not available. A credential was encrypted with a key this deployment cannot read.`,
      );
    }
    return key;
  }

  get versions(): number[] {
    return [...this.keys.keys()].sort((a, b) => a - b);
  }
}

/**
 * The only place provider credentials are encrypted or decrypted (ADR-007).
 *
 * Callers must decrypt immediately before a provider call and must never store the
 * plaintext, return it from an endpoint or log it (plan §7.2).
 */
export class CredentialCipher {
  constructor(private readonly keyring: Keyring) {}

  async encrypt(plaintext: string, context: CredentialContext): Promise<EncryptedRecord> {
    const version = this.keyring.activeVersion;
    const key = await this.keyring.key(version);
    const nonce = randomBytes(NONCE_LENGTH);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: canonicalAad(context) as BufferSource },
      key,
      utf8ToBytes(plaintext) as BufferSource,
    );

    return {
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      nonce: bytesToBase64(nonce),
      algorithm: CREDENTIAL_ALGORITHM,
      keyVersion: version,
    };
  }

  async decrypt(record: EncryptedRecord, context: CredentialContext): Promise<string> {
    if (record.algorithm !== CREDENTIAL_ALGORITHM) {
      throw new CredentialDecryptionError(
        `Unsupported credential algorithm "${record.algorithm}".`,
      );
    }

    const key = await this.keyring.key(record.keyVersion);

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: base64ToBytes(record.nonce) as BufferSource,
          additionalData: canonicalAad(context) as BufferSource,
        },
        key,
        base64ToBytes(record.ciphertext) as BufferSource,
      );
      return bytesToUtf8(new Uint8Array(plaintext));
    } catch (cause) {
      // GCM authentication failed: the ciphertext was tampered with, the key version is
      // wrong, or the record is being read under a different tenant context than it was
      // written under. The cause is deliberately not surfaced to callers.
      throw new CredentialDecryptionError(
        'Credential could not be decrypted. The record may have been tampered with or bound to a different context.',
        { cause },
      );
    }
  }

  /** True when a record predates the active key version and should be re-encrypted on next write. */
  needsRotation(record: EncryptedRecord): boolean {
    return record.keyVersion !== this.keyring.activeVersion;
  }

  /** Re-encrypt under the active key version. Used by lazy rotation on credential refresh. */
  async rotate(record: EncryptedRecord, context: CredentialContext): Promise<EncryptedRecord> {
    const plaintext = await this.decrypt(record, context);
    return this.encrypt(plaintext, context);
  }
}
