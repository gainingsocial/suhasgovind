import type { ProviderCallContext, ProviderCallLogEntry } from '../types.js';

/**
 * A `ProviderCallContext` for tests, with the call log captured rather than shipped.
 *
 * The captured log is what lets the certification harness assert that an adapter records
 * its provider calls at all — Rule 6 requires observability on every side effect, and an
 * adapter that silently skips it passes every other test.
 */
export interface TestContextOptions {
  environment?: 'test' | 'live';
  /** Aborts the context after this many milliseconds, to exercise timeout handling. */
  abortAfterMs?: number;
}

export interface TestContext extends ProviderCallContext {
  readonly entries: readonly ProviderCallLogEntry[];
  /** Aborts the underlying signal, simulating a caller-side deadline. */
  readonly abort: () => void;
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const entries: ProviderCallLogEntry[] = [];
  const controller = new AbortController();

  if (options.abortAfterMs !== undefined) {
    setTimeout(() => controller.abort(), options.abortAfterMs);
  }

  return {
    requestId: 'req_test',
    traceId: 'trc_test',
    signal: controller.signal,
    environment: options.environment ?? 'test',
    log: (entry) => entries.push(entry),
    entries,
    abort: () => controller.abort(),
  };
}
