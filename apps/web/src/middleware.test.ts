import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { middleware } from './middleware';

/**
 * Middleware routing.
 *
 * These cover the hostname collapse and the path gate — the two behaviours that decide
 * whether a person clicking "Open dashboard" arrives anywhere. The session-dependent
 * branches are deliberately not exercised here: they need a live Supabase project, so
 * they belong to the integration suite rather than to a hermetic unit test.
 *
 * Supabase configuration is stubbed away rather than merely assumed absent, and that
 * distinction cost a red build: locally the variables are unset, so `middleware` returned
 * before any network call and every assertion passed. CI *does* set them, so the same code
 * ran on to the session check and redirected `/app` to `/signin` — a test that passed for
 * a reason that had nothing to do with what it claimed to verify. Stubbing makes the
 * behaviour the same in both places.
 */

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(url: string): NextRequest {
  const host = new URL(url).host;
  return new NextRequest(new Request(url, { headers: { host } }));
}

describe('canonical hostname', () => {
  it('sends the app subdomain to the apex, preserving the path', async () => {
    const response = await middleware(request('https://app.gainingsocial.com/app/keys'));

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://gainingsocial.com/app/keys');
  });

  it('sends the bare app subdomain root to the apex rather than the marketing home', async () => {
    // The reported bug: this URL served a byte-identical copy of the marketing home page,
    // so "Open dashboard" looked like a button that did nothing.
    const response = await middleware(request('https://app.gainingsocial.com/'));

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://gainingsocial.com/');
  });

  it('sends www to the apex', async () => {
    const response = await middleware(request('https://www.gainingsocial.com/pricing'));

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://gainingsocial.com/pricing');
  });

  it('preserves the query string, so ?next= survives the redirect', async () => {
    const response = await middleware(
      request('https://app.gainingsocial.com/signin?next=%2Fapp%2Fkeys'),
    );

    expect(response.headers.get('location')).toBe(
      'https://gainingsocial.com/signin?next=%2Fapp%2Fkeys',
    );
  });

  it('leaves the canonical host alone', async () => {
    const response = await middleware(request('https://gainingsocial.com/pricing'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('leaves localhost alone, so development is not redirected to production', async () => {
    // A marketing path, so this asserts the hostname rule and nothing about sessions.
    const response = await middleware(request('http://localhost:3000/pricing'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('does not match a hostname that merely ends in the canonical domain', async () => {
    // `notgainingsocial.com` must not be treated as ours.
    const response = await middleware(request('https://www.notgainingsocial.com/'));

    expect(response.status).toBe(200);
  });
});

describe('session gate', () => {
  it('lets a marketing page through without touching Supabase', async () => {
    const response = await middleware(request('https://gainingsocial.com/features'));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});
