import { describe, expect, it } from 'vitest';

import {
  ID_PREFIXES,
  fromPublicId,
  isPublicId,
  newId,
  newRequestId,
  newUuidV7,
  resourceKindOf,
  toPublicId,
  uuidV7Timestamp,
} from './ids.js';

describe('UUIDv7', () => {
  it('produces a well-formed version 7 variant 10 UUID', () => {
    const uuid = newUuidV7();

    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encodes the creation time', () => {
    // Far enough ahead of both wall-clock time and any timestamp an earlier test
    // advanced the generator to, so the monotonic clamp below does not apply.
    const now = 4_100_000_000_000;
    const uuid = newUuidV7(now);

    expect(uuidV7Timestamp(uuid)?.getTime()).toBe(now);
  });

  it('never goes backwards when the clock does', () => {
    // RFC 9562 §6.2: guard against clock regression. A leap second or an NTP correction
    // must not produce an ID that sorts before one already handed out — the post timeline
    // and cursor pagination both depend on IDs only ever increasing.
    const forward = newUuidV7(4_200_000_000_000);
    const afterRollback = newUuidV7(4_100_000_000_000);

    expect(afterRollback > forward).toBe(true);
    expect(uuidV7Timestamp(afterRollback)!.getTime()).toBeGreaterThanOrEqual(4_200_000_000_000);
  });

  it('is monotonically increasing even within a single millisecond', () => {
    // The post timeline sorts by ID. Without the sub-millisecond counter, a burst of
    // targets created in the same millisecond would sort arbitrarily.
    const now = 4_300_000_000_000;
    const ids = Array.from({ length: 500 }, () => newUuidV7(now));

    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!, `${ids[i]} should sort after ${ids[i - 1]}`).toBe(true);
    }
  });

  it('rolls into the next millisecond when the 12-bit counter is exhausted', () => {
    const now = 4_400_000_000_000;
    const ids = Array.from({ length: 5000 }, () => newUuidV7(now));

    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!, `${ids[i]} should sort after ${ids[i - 1]}`).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts lexicographically in creation order across milliseconds', () => {
    const early = newUuidV7(4_500_000_000_000);
    const later = newUuidV7(4_500_000_000_500);

    expect(later > early).toBe(true);
    expect(uuidV7Timestamp(later)!.getTime()).toBe(4_500_000_000_500);
  });

  it('does not collide across many generations', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => newUuidV7()));
    expect(ids.size).toBe(20_000);
  });

  it('rejects a non-UUID when reading a timestamp', () => {
    expect(uuidV7Timestamp('not-a-uuid')).toBeNull();
  });
});

describe('public IDs', () => {
  it('round-trips every resource kind', () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const uuid = newUuidV7();
      const publicId = toPublicId(kind, uuid);

      expect(publicId.startsWith(`${ID_PREFIXES[kind]}_`)).toBe(true);
      expect(fromPublicId(kind, publicId)).toBe(uuid);
    }
  });

  it('produces a 26-character body', () => {
    const { publicId } = newId('post');
    expect(publicId).toMatch(/^pst_[0-9a-z]{26}$/);
  });

  it('refuses to decode under the wrong prefix', () => {
    // Plan P5: passing a media ID where a post ID is expected must not resolve to a row.
    const { publicId } = newId('media');

    expect(fromPublicId('media', publicId)).not.toBeNull();
    expect(fromPublicId('post', publicId)).toBeNull();
  });

  it('rejects malformed input rather than throwing', () => {
    expect(fromPublicId('post', 'pst_')).toBeNull();
    expect(fromPublicId('post', 'pst_tooshort')).toBeNull();
    expect(fromPublicId('post', 'garbage')).toBeNull();
    expect(fromPublicId('post', `pst_${'!'.repeat(26)}`)).toBeNull();
    expect(isPublicId('post', 'pst_' + 'z'.repeat(25))).toBe(false);
  });

  it('never emits ambiguous characters', () => {
    // Crockford excludes I, L, O and U so a transcribed ID cannot be misread.
    for (let i = 0; i < 200; i += 1) {
      expect(newId('post').publicId).not.toMatch(/[ilou]/);
    }
  });

  it('accepts Crockford decoding aliases so a mistyped ID still resolves', () => {
    const uuid = newUuidV7();
    const publicId = toPublicId('post', uuid);
    const withAmbiguity = publicId.replace(/1/g, 'l').replace(/0/g, 'O');

    expect(fromPublicId('post', withAmbiguity)).toBe(uuid);
  });

  it('is case-insensitive on decode', () => {
    const uuid = newUuidV7();
    const publicId = toPublicId('profile', uuid);

    expect(fromPublicId('profile', publicId.toUpperCase().replace('PRO_', 'pro_'))).toBe(uuid);
  });

  it('identifies the resource kind from a prefix', () => {
    expect(resourceKindOf(newId('postTarget').publicId)).toBe('postTarget');
    expect(resourceKindOf('unknown_abc')).toBeNull();
    expect(resourceKindOf('noseparator')).toBeNull();
  });

  it('throws on a malformed UUID when encoding, because that is a programming error', () => {
    expect(() => toPublicId('post', 'nope')).toThrow(/not a UUID/);
  });

  it('sorts public IDs in creation order', () => {
    const first = toPublicId('post', newUuidV7(4_600_000_000_000));
    const second = toPublicId('post', newUuidV7(4_600_000_001_000));

    expect(second > first).toBe(true);
  });
});

describe('correlation IDs', () => {
  it('uses the documented prefixes', () => {
    expect(newRequestId()).toMatch(/^req_[0-9a-z]{26}$/);
  });
});
