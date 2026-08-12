import type { ProviderCallContext } from '@gs/provider-kit';
import type { Logger } from '@gs/observability';

import type { Env } from './env.js';

/**
 * Build the `ProviderCallContext` for a worker-side adapter call.
 *
 * Same contract as the API's, different lifetime: there is no request to hang the
 * deadline off, so the timer is the only thing bounding the call. Rule 6 requires it —
 * a provider call without a deadline holds a queue consumer until the runtime kills it,
 * and the message is then redelivered to do exactly the same thing again.
 */
export interface WorkerProviderContextInput {
  requestId: string;
  traceId: string;
  timeoutMs: number;
  logger: Logger;
}

export function providerContext(env: Env, input: WorkerProviderContextInput): ProviderCallContext {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

  return {
    requestId: input.requestId,
    traceId: input.traceId,
    signal: controller.signal,
    // A test environment must never produce a real provider side effect (plan §49).
    environment: env.ENVIRONMENT,
    log: (entry) => {
      // The logger redacts before writing. Adapters are still forbidden from putting a
      // credential in here at all (P9, §7.2).
      input.logger.info('provider.call', {
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
