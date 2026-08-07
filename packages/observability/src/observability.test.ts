import { describe, expect, it } from 'vitest';

import { createLogger, newTraceContext, parseLogLevel } from './logger.js';
import type { LogLevel } from './logger.js';
import { buildProviderCallRecord, parseRateLimitHeaders } from './provider-call-log.js';
import { redact, redactString, redactUrl } from './redaction.js';

function capture(level: LogLevel = 'debug') {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(newTraceContext({ traceId: 'trc_1', requestId: 'req_1' }), {
    level,
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date('2026-08-07T05:16:00.000Z'),
    service: 'api',
  });
  return { lines, logger };
}

describe('redaction', () => {
  it('removes values under secret-looking keys', () => {
    const result = redact({
      access_token: 'ya29.super-secret',
      refreshToken: 'refresh-me',
      'client-secret': 'shh',
      apiKey: 'k',
      password: 'p',
      Authorization: 'Bearer abc',
      safe: 'keep me',
    }) as Record<string, unknown>;

    expect(result.access_token).toBe('[REDACTED]');
    expect(result.refreshToken).toBe('[REDACTED]');
    expect(result['client-secret']).toBe('[REDACTED]');
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result.safe).toBe('keep me');
  });

  it('redacts nested provider payloads', () => {
    const result = redact({
      response: { data: { credentials: { access_token: 'secret' }, id: 'abc' } },
    }) as any;

    expect(result.response.data.credentials.access_token).toBe('[REDACTED]');
    expect(result.response.data.id).toBe('abc');
  });

  it('catches secrets pasted into innocuous fields', () => {
    // Assembled at runtime rather than written as a literal. The value is synthetic, but
    // `sk_live_…` is our own API key shape (plan §38) and secret scanners flag it on sight
    // — a contiguous literal here gets the whole push rejected.
    const apiKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz012345'].join('_');

    // The key name is fine; the value is not. Deny-by-key alone would miss this.
    const result = redact({ note: `use ${apiKey} to publish` }) as any;

    expect(result.note).toContain('[REDACTED]');
    expect(result.note).not.toContain(apiKey);
  });

  it('redacts JWTs and Meta-style tokens in free text', () => {
    expect(redactString('token EAABwzLixnjYBO1ZBxyzabc123456789')).toContain('[REDACTED]');
    expect(
      redactString('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
    ).toBe('[REDACTED]');
  });

  it('redacts Headers objects', () => {
    const headers = new Headers({ authorization: 'Bearer abc', 'content-type': 'application/json' });
    const result = redact(headers) as Record<string, unknown>;

    expect(result.authorization).toBe('[REDACTED]');
    expect(result['content-type']).toBe('application/json');
  });

  it('survives circular structures', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node.self = node;

    expect(() => redact(node)).not.toThrow();
    expect((redact(node) as any).self).toBe('[CIRCULAR]');
  });

  it('bounds deep nesting and long strings', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i += 1) deep = { next: deep };

    expect(JSON.stringify(redact(deep))).toContain('MAX_DEPTH');
    expect(redact({ text: 'x'.repeat(5000) }, { maxStringLength: 100 }) as any).toMatchObject({
      text: expect.stringContaining('[truncated]'),
    });
  });

  it('does not mutate its input', () => {
    const original = { access_token: 'secret' };
    redact(original);

    expect(original.access_token).toBe('secret');
  });

  it('redacts OAuth codes out of callback URLs', () => {
    const redacted = redactUrl('https://api.example.com/callback?code=4/0AX4&state=xyz&provider=linkedin');

    expect(redacted).toContain('code=%5BREDACTED%5D');
    expect(redacted).toContain('state=%5BREDACTED%5D');
    expect(redacted).toContain('provider=linkedin');
  });

  it('falls back to string redaction for a malformed URL', () => {
    expect(redactUrl('not a url sk_test_abcdefghijklmnopqrstuvwxyz012345')).toContain('[REDACTED]');
  });
});

describe('logger', () => {
  it('emits one JSON line carrying the trace context', () => {
    const { lines, logger } = capture();
    logger.info('post_accepted', { post_id: 'pst_1' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      timestamp: '2026-08-07T05:16:00.000Z',
      level: 'info',
      message: 'post_accepted',
      service: 'api',
      traceId: 'trc_1',
      requestId: 'req_1',
      post_id: 'pst_1',
    });
  });

  it('honours the minimum level', () => {
    const { lines, logger } = capture('warn');

    logger.debug('ignored');
    logger.info('ignored');
    logger.warn('kept');
    logger.error('kept');

    expect(lines.map((line) => line.level)).toEqual(['warn', 'error']);
  });

  it('redacts caller-supplied fields', () => {
    const { lines, logger } = capture();
    logger.info('token_refreshed', { access_token: 'ya29.secret' });

    expect(lines[0]!.access_token).toBe('[REDACTED]');
    expect(JSON.stringify(lines[0])).not.toContain('ya29.secret');
  });

  it('inherits and extends context through child loggers', () => {
    const { lines, logger } = capture();
    const target = logger.child({ provider: 'bluesky', targetId: 'ptg_1' }, { attempt: 2 });

    target.info('publishing');

    expect(lines[0]).toMatchObject({
      traceId: 'trc_1',
      provider: 'bluesky',
      targetId: 'ptg_1',
      attempt: 2,
    });
  });

  it('never lets an unserializable field break the caller', () => {
    const { lines, logger } = capture();
    logger.info('weird', { value: 1n, fn: () => undefined });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.value).toBe('1');
  });

  it('generates correlation IDs when none are supplied', () => {
    const context = newTraceContext();

    expect(context.traceId).toMatch(/^trc_/);
    expect(context.requestId).toMatch(/^req_/);
  });

  it('falls back to info for an unknown configured level', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('verbose')).toBe('info');
    expect(parseLogLevel(undefined)).toBe('info');
  });
});

describe('provider call records', () => {
  it('redacts the URL query string and bounds summaries', () => {
    const record = buildProviderCallRecord({
      provider: 'linkedin',
      operation: 'create_post',
      method: 'POST',
      url: 'https://api.linkedin.com/rest/posts?access_token=secret',
      requestSummary: { author: 'urn:li:person:1', commentary: 'x'.repeat(3000) },
      responseSummary: { id: 'urn:li:share:1' },
      status: 201,
      durationMs: 412,
      outcome: 'success',
    });

    expect(record.url).not.toContain('secret');
    expect(JSON.stringify(record.requestSummary)).not.toContain('x'.repeat(600));
    expect(record.responseSummary).toEqual({ id: 'urn:li:share:1' });
  });

  it('truncates an oversized summary rather than storing it', () => {
    const record = buildProviderCallRecord({
      provider: 'meta',
      operation: 'publish',
      method: 'POST',
      url: 'https://graph.facebook.com/v21.0/me/feed',
      responseSummary: { items: Array.from({ length: 500 }, (_, i) => ({ index: i, note: 'padding' })) },
      durationMs: 90,
      outcome: 'success',
    });

    expect(record.responseSummary).toMatchObject({ truncated: true });
  });
});

describe('rate-limit header parsing', () => {
  const now = new Date('2026-08-07T05:00:00.000Z');

  it('reads IETF RateLimit-* headers', () => {
    const parsed = parseRateLimitHeaders(
      new Headers({ 'RateLimit-Limit': '100', 'RateLimit-Remaining': '7', 'RateLimit-Reset': '60' }),
      now,
    );

    expect(parsed).toEqual({ limit: 100, remaining: 7, resetAt: '2026-08-07T05:01:00.000Z' });
  });

  it('reads X-RateLimit-* headers', () => {
    const parsed = parseRateLimitHeaders(new Headers({ 'X-RateLimit-Remaining': '0' }), now);
    expect(parsed).toEqual({ remaining: 0 });
  });

  it('treats a large reset value as an epoch timestamp', () => {
    const parsed = parseRateLimitHeaders(new Headers({ 'X-RateLimit-Reset': '1786000000' }), now);
    expect(parsed?.resetAt).toBe(new Date(1_786_000_000_000).toISOString());
  });

  it('reads a numeric Retry-After', () => {
    const parsed = parseRateLimitHeaders(new Headers({ 'Retry-After': '120' }), now);

    expect(parsed?.retryAfterSeconds).toBe(120);
    expect(parsed?.resetAt).toBe('2026-08-07T05:02:00.000Z');
  });

  it('reads an HTTP-date Retry-After', () => {
    const parsed = parseRateLimitHeaders(
      new Headers({ 'Retry-After': 'Fri, 07 Aug 2026 05:05:00 GMT' }),
      now,
    );

    expect(parsed?.resetAt).toBe('2026-08-07T05:05:00.000Z');
    expect(parsed?.retryAfterSeconds).toBe(300);
  });

  it('returns undefined when the provider said nothing', () => {
    expect(parseRateLimitHeaders(new Headers(), now)).toBeUndefined();
  });
});
