import type { ProviderCallContext } from '@gs/provider-kit';
import type { Context } from 'hono';

import type { AppEnv } from '../env.js';

/**
 * Build the `ProviderCallContext` every adapter call requires.
 *
 * Three things it guarantees, all of which Rule 6 demands of any provider side effect:
 *
 *   timeout        an `AbortSignal` with a real deadline, so a slow provider cannot hold
 *                  a Worker until the runtime kills it
 *   traceability   the inbound request and trace ids, so a provider call is attributable
 *                  end to end
 *   observability  a log sink, so the call is recorded whatever the outcome
 *
 * Building it in one place is what stops the fourth caller from passing
 * `new AbortController().signal` and quietly disabling the deadline.
 */
export interface ProviderContextOptions {
  timeoutMs: number;
}

export function providerCallContext(
  c: Context<AppEnv>,
  options: ProviderContextOptions,
): ProviderCallContext {
  const trace = c.get('trace');
  const logger = c.get('logger');
  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  // Clearing on abort keeps a fired deadline from holding a reference; `providerFetch`
  // clears its own inner timer, and the Workers runtime discards pending timers when the
  // request's isolate context ends.
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

  const principal = c.get('principal');

  return {
    requestId: trace.requestId,
    traceId: trace.traceId,
    signal: controller.signal,
    // A test key must never produce a real provider side effect (plan §49).
    environment: principal?.environment ?? 'test',
    log: (entry) => {
      // The logger redacts before writing; adapters are still forbidden from putting a
      // credential in here at all (P9, §7.2).
      logger.info('provider.call', {
        operation: entry.operation,
        method: entry.method,
        path: entry.path,
        status: entry.status,
        durationMs: entry.durationMs,
        providerRequestId: entry.providerRequestId,
        ...(entry.detail ?? {}),
      });
    },
  };
}
