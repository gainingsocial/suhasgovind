import { PROVIDER_NAMES } from '@gs/contracts/providers';
import { ApiError } from '@gs/errors';
import { afterEach, describe, expect, it } from 'vitest';

import { getAdapter, hasAdapter, implementedProviders, resetAdapterCache } from './index.js';

afterEach(() => {
  resetAdapterCache();
});

describe('provider registry', () => {
  it('resolves a registered adapter', () => {
    const adapter = getAdapter('mock');
    expect(adapter.provider).toBe('mock');
  });

  it('returns the same instance across calls', () => {
    // Adapters are stateless and configuration arrives per call, so caching one per
    // isolate avoids rebuilding capability documents on every request.
    expect(getAdapter('mock')).toBe(getAdapter('mock'));
  });

  it('rejects an unknown provider name with a typed error', () => {
    const error = (() => {
      try {
        getAdapter('myspace');
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PROVIDER_NOT_SUPPORTED');
  });

  it('rejects a known provider that has no adapter yet', () => {
    // `linkedin` is a real provider in PROVIDER_NAMES with no implementation. It must
    // fail the same way as an unknown name rather than returning undefined into a
    // publish path (Rule 14).
    expect(() => getAdapter('linkedin')).toThrow(ApiError);
    expect(hasAdapter('linkedin')).toBe(false);
  });

  it('reports implemented providers as a subset of all known providers', () => {
    const implemented = implementedProviders();
    expect(implemented.length).toBeGreaterThan(0);
    for (const provider of implemented) {
      expect(PROVIDER_NAMES).toContain(provider);
      expect(hasAdapter(provider)).toBe(true);
    }
  });

  it('narrows the type via hasAdapter', () => {
    expect(hasAdapter('mock')).toBe(true);
    expect(hasAdapter('not-a-provider')).toBe(false);
  });
});
