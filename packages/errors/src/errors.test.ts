import { describe, expect, it } from 'vitest';

import { ApiError, errors } from './api-error.js';
import { ERROR_CODE_METADATA } from './catalog.js';
import { ERROR_CODES, isKnownErrorCode } from './codes.js';
import { providerErrorToApiError } from './bridge.js';
import {
  PROVIDER_ERROR_CODES,
  PROVIDER_ERROR_METADATA,
  dispositionFor,
  isRetryable,
} from './provider-taxonomy.js';

const ctx = { requestId: 'req_01', traceId: 'trc_01' };

describe('error code catalog', () => {
  it('has metadata for every public code', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_CODE_METADATA[code], `missing metadata for ${code}`).toBeDefined();
    }
  });

  it('has no duplicate codes', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('uses SCREAMING_SNAKE_CASE for every code', () => {
    for (const code of ERROR_CODES) {
      expect(code, `${code} is not SCREAMING_SNAKE_CASE`).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('maps every code to a plausible HTTP status', () => {
    for (const code of ERROR_CODES) {
      const { status } = ERROR_CODE_METADATA[code];
      expect(status, `${code} has status ${status}`).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('recognizes known codes and rejects unknown ones', () => {
    expect(isKnownErrorCode('TEXT_TOO_LONG')).toBe(true);
    expect(isKnownErrorCode('NOPE_NOT_A_CODE')).toBe(false);
  });
});

describe('ApiError envelope', () => {
  it('always includes retryable, docs_url, request_id and trace_id', () => {
    // Plan §16: `retryable` must be explicit and an agent must never have to parse prose.
    const envelope = new ApiError('TEXT_TOO_LONG').toEnvelope(ctx);

    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.docs_url).toBe('https://docs.gainingsocial.com/errors/TEXT_TOO_LONG');
    expect(envelope.error.request_id).toBe('req_01');
    expect(envelope.error.trace_id).toBe('trc_01');
    expect(envelope.error.agent_action).toBe('shorten_text');
  });

  it('omits absent optional fields rather than emitting nulls', () => {
    const envelope = new ApiError('POST_NOT_FOUND').toEnvelope(ctx);

    expect(envelope.error).not.toHaveProperty('param');
    expect(envelope.error).not.toHaveProperty('provider');
    expect(envelope.error).not.toHaveProperty('provider_error');
    expect(envelope.error).not.toHaveProperty('details');
  });

  it('carries destination and param context for per-target validation failures', () => {
    const envelope = new ApiError('MEDIA_RATIO_UNSUPPORTED', {
      message: 'The selected video is not valid for the TikTok destination.',
      param: 'content.media_ids[0]',
      provider: 'tiktok',
      destinationId: 'dst_123',
      suggestedActions: [{ action: 'create_media_variant', params: { aspect_ratio: '9:16' } }],
    }).toEnvelope(ctx);

    expect(envelope.error.param).toBe('content.media_ids[0]');
    expect(envelope.error.provider).toBe('tiktok');
    expect(envelope.error.destination_id).toBe('dst_123');
    expect(envelope.error.suggested_actions).toEqual([
      { action: 'create_media_variant', params: { aspect_ratio: '9:16' } },
    ]);
  });

  it('lets an occurrence override the catalog default retryability', () => {
    const err = new ApiError('PROVIDER_UNAVAILABLE', { retryable: false });
    expect(ERROR_CODE_METADATA.PROVIDER_UNAVAILABLE.retryable).toBe(true);
    expect(err.retryable).toBe(false);
  });

  it('does not leak the detail of an unrecognized throwable', () => {
    const wrapped = ApiError.from(new Error('postgres://user:hunter2@db.internal/postgres failed'));

    expect(wrapped.code).toBe('INTERNAL_ERROR');
    expect(wrapped.message).not.toContain('hunter2');
    expect(JSON.stringify(wrapped.toEnvelope(ctx))).not.toContain('hunter2');
  });

  it('returns an ApiError unchanged when wrapping one', () => {
    const original = new ApiError('PROFILE_NOT_FOUND');
    expect(ApiError.from(original)).toBe(original);
  });
});

describe('convenience constructors', () => {
  it('names the missing scope in both the message and a suggested action', () => {
    const err = errors.insufficientScope('posts:write');

    expect(err.status).toBe(403);
    expect(err.message).toContain('posts:write');
    expect(err.suggestedActions?.[0]).toEqual({
      action: 'request_key_with_required_scope',
      params: { scope: 'posts:write' },
    });
  });
});

describe('provider error taxonomy', () => {
  it('has metadata for every provider code', () => {
    for (const code of PROVIDER_ERROR_CODES) {
      expect(PROVIDER_ERROR_METADATA[code], `missing metadata for ${code}`).toBeDefined();
    }
  });

  it('points every provider code at a real public code', () => {
    for (const code of PROVIDER_ERROR_CODES) {
      expect(isKnownErrorCode(PROVIDER_ERROR_METADATA[code].publicCode)).toBe(true);
    }
  });

  it('never auto-retries an ambiguous outcome without reconciling first', () => {
    // ADR-006 Layer 4. A timeout cannot distinguish "never arrived" from
    // "published, response lost", so blind retry is how duplicates get created.
    const ambiguous = ['PROVIDER_TIMEOUT', 'PROVIDER_CONFLICT', 'POSSIBLE_DUPLICATE', 'UNKNOWN_PROVIDER_ERROR'] as const;

    for (const code of ambiguous) {
      const meta = PROVIDER_ERROR_METADATA[code];
      expect(meta.disposition, code).toBe('unknown_reconciliation_required');
      expect(meta.retryStrategy, code).toBe('reconcile_first');
    }
  });

  it('treats permanent content failures as non-retryable', () => {
    const permanent = ['TEXT_TOO_LONG', 'MEDIA_UNSUPPORTED', 'MEDIA_TOO_LARGE', 'CONTENT_REJECTED', 'VALIDATION_FAILED'] as const;

    for (const code of permanent) {
      expect(PROVIDER_ERROR_METADATA[code].retryable, code).toBe(false);
      expect(PROVIDER_ERROR_METADATA[code].disposition, code).toBe('permanent_failed');
    }
  });

  it('routes every auth failure to connection health rather than a content retry', () => {
    const auth = ['AUTH_EXPIRED', 'AUTH_REVOKED', 'AUTH_SCOPE_MISSING'] as const;

    for (const code of auth) {
      const meta = PROVIDER_ERROR_METADATA[code];
      expect(meta.disposition, code).toBe('blocked_on_connection');
      expect(meta.affectsConnectionHealth, code).toBe(true);
      expect(meta.severity, code).toBe('reauthorization_required');
    }
  });

  it('honours an adapter override of disposition and retryability', () => {
    // An adapter may know that a particular 503 is permanent for this content.
    const overridden = {
      code: 'PROVIDER_UNAVAILABLE',
      message: 'endpoint retired',
      retryable: false,
      disposition: 'permanent_failed',
    } as const;

    expect(isRetryable(overridden)).toBe(false);
    expect(dispositionFor(overridden)).toBe('permanent_failed');
  });

  it('falls back to taxonomy defaults with no override', () => {
    const plain = { code: 'RATE_LIMITED', message: 'slow down' } as const;

    expect(isRetryable(plain)).toBe(true);
    expect(dispositionFor(plain)).toBe('retryable_failed');
  });
});

describe('providerErrorToApiError', () => {
  it('sanitizes the provider message but keeps the normalized code and subcode', () => {
    const apiError = providerErrorToApiError(
      {
        code: 'RATE_LIMITED',
        subcode: '4',
        status: 429,
        message: 'Application request limit reached for token EAAB...secret',
        retryAfter: '2026-08-07T06:00:00.000Z',
      },
      { provider: 'facebook', destinationId: 'dst_9', targetId: 'ptg_9' },
    );

    const envelope = apiError.toEnvelope(ctx);

    expect(envelope.error.provider_error).toEqual({ code: 'RATE_LIMITED', subcode: '4', status: 429 });
    expect(JSON.stringify(envelope)).not.toContain('EAAB');
    expect(envelope.error.retryable).toBe(true);
    expect(envelope.error.retry_after).toBe('2026-08-07T06:00:00.000Z');
    expect(envelope.error.destination_id).toBe('dst_9');
    expect(envelope.error.target_id).toBe('ptg_9');
  });

  it('maps an ambiguous timeout to RECONCILIATION_REQUIRED, not a retry instruction', () => {
    const apiError = providerErrorToApiError(
      { code: 'PROVIDER_TIMEOUT', message: 'timed out' },
      { provider: 'linkedin' },
    );

    expect(apiError.code).toBe('RECONCILIATION_REQUIRED');
    expect(apiError.agentAction).toBe('wait_for_reconciliation');
  });
});
