import { ApiError } from '@gs/errors';
import { describe, expect, it } from 'vitest';

import { assertSafeMediaUrl, isBlockedHost } from './ssrf.js';

/**
 * SSRF is the one place where a missed case is directly exploitable, so these enumerate
 * the specific addresses an attacker reaches for rather than testing the idea generally.
 */
describe('assertSafeMediaUrl', () => {
  const rejects = (url: string) => {
    expect(() => assertSafeMediaUrl(url), url).toThrow(ApiError);
    try {
      assertSafeMediaUrl(url);
    } catch (error) {
      expect((error as ApiError).code).toBe('MEDIA_URL_NOT_ALLOWED');
    }
  };

  it('accepts ordinary public https media', () => {
    expect(assertSafeMediaUrl('https://cdn.example.com/a/b/video.mp4').hostname).toBe(
      'cdn.example.com',
    );
    expect(() => assertSafeMediaUrl('http://images.example.com/x.png')).not.toThrow();
    // A high port on a public host is normal behind a CDN and must not be rejected.
    expect(() => assertSafeMediaUrl('https://cdn.example.com:8443/x.png')).not.toThrow();
  });

  it('rejects non-http schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://example.com/',
      'data:image/png;base64,AAAA',
      'ftp://example.com/x.png',
    ]) {
      rejects(url);
    }
  });

  it('rejects loopback in every spelling', () => {
    for (const url of [
      'http://localhost/x.png',
      'http://LOCALHOST/x.png',
      'http://127.0.0.1/x.png',
      'http://127.1.2.3/x.png',
      'http://[::1]/x.png',
      'http://app.localhost/x.png',
    ]) {
      rejects(url);
    }
  });

  it('rejects cloud metadata endpoints', () => {
    // The prize in most SSRF attacks: these hand out credentials to anything that asks
    // from the right network position.
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata/computeMetadata/v1/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
    ]) {
      rejects(url);
    }
  });

  it('rejects RFC 1918 and carrier-grade NAT ranges', () => {
    for (const url of [
      'http://10.0.0.5/x.png',
      'http://172.16.0.1/x.png',
      'http://172.31.255.254/x.png',
      'http://192.168.1.1/x.png',
      'http://100.64.0.1/x.png',
      'http://0.0.0.0/x.png',
    ]) {
      rejects(url);
    }
  });

  it('allows public addresses that merely look adjacent to private ones', () => {
    // 172.15 and 172.32 are outside RFC 1918; an over-broad check would block them.
    expect(() => assertSafeMediaUrl('http://172.15.0.1/x.png')).not.toThrow();
    expect(() => assertSafeMediaUrl('http://172.32.0.1/x.png')).not.toThrow();
    expect(() => assertSafeMediaUrl('http://11.0.0.1/x.png')).not.toThrow();
  });

  it('rejects IPv6 unique-local and link-local', () => {
    for (const url of ['http://[fc00::1]/x.png', 'http://[fd12:3456::1]/x.png', 'http://[fe80::1]/x.png']) {
      rejects(url);
    }
  });

  it('rejects credentials in the URL', () => {
    // They would be forwarded to whatever we fetch; plan §68 forbids credential forwarding.
    rejects('https://user:password@cdn.example.com/x.png');
  });

  it('rejects internal service ports', () => {
    for (const url of [
      'http://cdn.example.com:6379/x',
      'http://cdn.example.com:5432/x',
      'http://cdn.example.com:22/x',
    ]) {
      rejects(url);
    }
  });

  it('rejects internal TLDs', () => {
    for (const url of ['http://db.internal/x.png', 'http://printer.local/x.png', 'http://wiki.corp/x.png']) {
      rejects(url);
    }
  });

  it('rejects an unparseable URL rather than passing it through', () => {
    rejects('not a url at all');
  });

  it('ignores a trailing dot used to evade suffix matching', () => {
    // `localhost.` resolves identically to `localhost` but fails a naive string compare.
    expect(isBlockedHost('localhost.')).toBe(true);
  });
});
