import { describe, expect, it } from 'vitest';

import {
  evaluateFlag,
  providerBlockedBy,
  providerFlagKey,
  type ResolvedFlag,
} from './environment-settings.js';

/**
 * Feature-flag evaluation (plan §45).
 *
 * The scope-precedence query needs a database and is covered in the integration suite.
 * What is tested here is the decision logic, whose defaults are the load-bearing part:
 * a rollout that defaults on ships an untested feature to everyone, and a kill switch that
 * defaults off takes every provider down whenever the flags table is empty — which is its
 * state in every environment nobody has configured.
 */

function flag(overrides: Partial<ResolvedFlag> = {}): ResolvedFlag {
  return {
    key: 'provider:instagram',
    enabled: true,
    decidedBy: 'global',
    value: null,
    rolloutPercentage: null,
    ...overrides,
  };
}

describe('evaluateFlag — opt-in semantics', () => {
  it('is off when the flag does not exist', () => {
    expect(evaluateFlag(undefined)).toBe(false);
  });

  it('is off when the flag exists but is disabled', () => {
    expect(evaluateFlag(flag({ enabled: false }))).toBe(false);
  });

  it('is on when enabled with no rollout limit', () => {
    expect(evaluateFlag(flag())).toBe(true);
  });

  it('is on for everyone at 100 percent', () => {
    expect(evaluateFlag(flag({ rolloutPercentage: 100 }), 'con_anything')).toBe(true);
  });

  it('is off for everyone at 0 percent', () => {
    expect(evaluateFlag(flag({ rolloutPercentage: 0 }), 'con_anything')).toBe(false);
  });

  it('is off for a partial rollout with no subject to bucket', () => {
    // Without a subject there is nothing stable to hash, and a random draw would flip the
    // feature on and off between a preflight and the publish it validated.
    expect(evaluateFlag(flag({ rolloutPercentage: 50 }))).toBe(false);
  });

  it('gives the same subject the same answer every time', () => {
    const partial = flag({ rolloutPercentage: 50 });
    const first = evaluateFlag(partial, 'con_stable');

    for (let i = 0; i < 20; i += 1) {
      expect(evaluateFlag(partial, 'con_stable')).toBe(first);
    }
  });

  it('splits a population roughly at the requested percentage', () => {
    const partial = flag({ rolloutPercentage: 25 });
    let included = 0;

    for (let i = 0; i < 2_000; i += 1) {
      if (evaluateFlag(partial, `con_${i}`)) included += 1;
    }

    // Wide bounds on purpose. This asserts the bucketing is not degenerate — not that a
    // non-cryptographic hash is perfectly uniform, which it does not need to be.
    expect(included).toBeGreaterThan(2_000 * 0.15);
    expect(included).toBeLessThan(2_000 * 0.35);
  });

  it('buckets independently per flag, so two rollouts do not hit the same people', () => {
    const a = flag({ key: 'feature:a', rolloutPercentage: 50 });
    const b = flag({ key: 'feature:b', rolloutPercentage: 50 });

    let differed = 0;
    for (let i = 0; i < 500; i += 1) {
      if (evaluateFlag(a, `con_${i}`) !== evaluateFlag(b, `con_${i}`)) differed += 1;
    }

    expect(differed).toBeGreaterThan(0);
  });
});

describe('providerBlockedBy — kill-switch semantics', () => {
  const flags = (entries: ResolvedFlag[]) => new Map(entries.map((entry) => [entry.key, entry]));

  it('allows a provider nobody has configured', () => {
    // The inverse default from evaluateFlag, and the whole reason they are two functions:
    // an empty flags table must not take every provider offline.
    expect(providerBlockedBy(flags([]), 'instagram')).toBeNull();
  });

  it('allows a provider whose flag exists and is enabled', () => {
    expect(providerBlockedBy(flags([flag({ key: 'provider:instagram' })]), 'instagram')).toBeNull();
  });

  it('blocks a provider whose flag is disabled', () => {
    const blocked = providerBlockedBy(
      flags([flag({ key: 'provider:instagram', enabled: false, decidedBy: 'project' })]),
      'instagram',
    );

    expect(blocked).toEqual({ key: 'provider:instagram', decidedBy: 'project' });
  });

  it('does not let one provider’s kill switch affect another', () => {
    const map = flags([flag({ key: 'provider:instagram', enabled: false })]);

    expect(providerBlockedBy(map, 'instagram')).not.toBeNull();
    expect(providerBlockedBy(map, 'linkedin')).toBeNull();
  });

  it('blocks one feature while leaving the rest of the provider working', () => {
    const map = flags([flag({ key: 'provider:instagram:reels', enabled: false })]);

    expect(providerBlockedBy(map, 'instagram', 'reels')).toMatchObject({
      key: 'provider:instagram:reels',
    });
    expect(providerBlockedBy(map, 'instagram')).toBeNull();
    expect(providerBlockedBy(map, 'instagram', 'carousel')).toBeNull();
  });

  it('lets a provider-wide kill switch also stop its features', () => {
    const map = flags([flag({ key: 'provider:instagram', enabled: false })]);

    expect(providerBlockedBy(map, 'instagram', 'reels')).toMatchObject({
      key: 'provider:instagram',
    });
  });

  it('prefers the more specific key when both are disabled', () => {
    const map = flags([
      flag({ key: 'provider:instagram', enabled: false, decidedBy: 'global' }),
      flag({ key: 'provider:instagram:reels', enabled: false, decidedBy: 'environment' }),
    ]);

    expect(providerBlockedBy(map, 'instagram', 'reels')).toEqual({
      key: 'provider:instagram:reels',
      decidedBy: 'environment',
    });
  });
});

describe('providerFlagKey', () => {
  it('names a provider and a provider feature distinctly', () => {
    expect(providerFlagKey('tiktok')).toBe('provider:tiktok');
    expect(providerFlagKey('tiktok', 'direct_post')).toBe('provider:tiktok:direct_post');
  });
});
