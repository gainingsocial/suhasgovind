import type { ProviderCallContext } from '@gs/provider-kit';

import { GraphError, graphCall } from './graph.js';

/**
 * The container publishing model, shared by Instagram and Threads.
 *
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 * https://developers.facebook.com/docs/threads/posts
 *
 * Both platforms publish in two steps: create a container describing the post, then
 * publish that container by id. This maps onto `prepare` / `publish` almost exactly, and
 * the fit is not a coincidence — plan §24 separates them for the same reason Meta does.
 *
 * The property that matters for effective-once publishing (ADR-006): **creating a
 * container is not publishing.** It has no public effect, and an abandoned one expires on
 * its own within 24 hours. So the whole slow, failure-prone half of the operation —
 * fetching media, waiting for a transcode — is freely retryable, and the single
 * irreversible act is one short call at the end. An adapter that created the container
 * inside `publish` would put the retry-prone work and the irreversible work in the same
 * step, which is how you get a duplicate post from a transcode timeout.
 */

/** Container states. Both platforms use the same vocabulary; only the field name differs. */
export type ContainerStatus = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';

export interface ContainerState {
  readonly status: ContainerStatus;
  readonly errorMessage: string | undefined;
}

export interface ContainerPollConfig {
  readonly host: string;
  /** Instagram calls it `status_code`; Threads calls it `status`. */
  readonly statusField: 'status_code' | 'status';
  readonly accessToken: string;
  readonly appSecret?: string;
  readonly containerId: string;
}

export async function readContainerStatus(
  context: ProviderCallContext,
  config: ContainerPollConfig,
): Promise<ContainerState> {
  const { data } = await graphCall<Record<string, string | undefined>>(context, {
    host: config.host,
    method: 'GET',
    path: `/${config.containerId}`,
    operation: 'containerStatus',
    query: { fields: `${config.statusField},error_message` },
    accessToken: config.accessToken,
    ...(config.appSecret ? { appSecret: config.appSecret } : {}),
  });

  const raw = data[config.statusField];

  return {
    // Rule 14: an unrecognized status is not optimistically treated as ready. Publishing an
    // unfinished container fails, and publishing one we misread as finished is worse.
    status: isContainerStatus(raw) ? raw : 'IN_PROGRESS',
    errorMessage: data.error_message,
  };
}

function isContainerStatus(value: string | undefined): value is ContainerStatus {
  return (
    value === 'EXPIRED' ||
    value === 'ERROR' ||
    value === 'FINISHED' ||
    value === 'IN_PROGRESS' ||
    value === 'PUBLISHED'
  );
}

export class ContainerNotReadyError extends Error {
  readonly containerId: string;
  readonly lastStatus: ContainerStatus;

  constructor(containerId: string, lastStatus: ContainerStatus, waitedMs: number) {
    super(
      `Media container ${containerId} was still ${lastStatus} after ${Math.round(waitedMs / 1000)}s of processing.`,
    );
    this.name = 'ContainerNotReadyError';
    this.containerId = containerId;
    this.lastStatus = lastStatus;
  }
}

export interface WaitOptions {
  /** Total time to wait before giving up. */
  readonly budgetMs: number;
  /** First gap between polls; doubles up to `maxIntervalMs`. */
  readonly initialIntervalMs?: number;
  readonly maxIntervalMs?: number;
}

/**
 * Poll a container until the platform finishes processing it.
 *
 * Called from `prepare`, never from `publish`. That placement is the whole point: if the
 * budget runs out here, the engine can retry the entire preparation safely, because
 * nothing published. A new container gets created and the abandoned one expires quietly.
 * The alternative — waiting inside `publish` — turns a slow transcode into a decision about
 * whether to risk a duplicate.
 *
 * Backs off geometrically rather than polling at a fixed interval: a video transcode takes
 * anywhere from two seconds to two minutes, and a tight loop against Meta burns the
 * account's rate-limit budget on questions rather than on posts.
 */
export async function waitForContainer(
  context: ProviderCallContext,
  config: ContainerPollConfig,
  options: WaitOptions,
): Promise<void> {
  const initial = options.initialIntervalMs ?? 2_000;
  const max = options.maxIntervalMs ?? 15_000;
  const deadline = Date.now() + options.budgetMs;

  let interval = initial;

  for (;;) {
    const state = await readContainerStatus(context, config);

    if (state.status === 'FINISHED' || state.status === 'PUBLISHED') return;

    if (state.status === 'ERROR' || state.status === 'EXPIRED') {
      // A terminal platform-side rejection. Retrying the same bytes cannot change it, so it
      // must not be reported as a transient failure.
      throw new GraphError(
        422,
        {
          code: 2207026,
          message:
            state.errorMessage ??
            `The platform could not process this media (${state.status.toLowerCase()}).`,
        },
        '',
      );
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ContainerNotReadyError(config.containerId, state.status, options.budgetMs);

    // Never sleep past the deadline, and never past the caller's own abort signal.
    await sleep(Math.min(interval, remaining), context.signal);
    interval = Math.min(interval * 2, max);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted while waiting for media processing.', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Aborted while waiting for media processing.', 'AbortError'));
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
