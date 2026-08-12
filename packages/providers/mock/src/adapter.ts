import type { ProviderCapabilities } from '@gs/contracts/capabilities';
import type { AdapterValidationResult, ValidationFinding } from '@gs/contracts/validation';
import type { NormalizedProviderError } from '@gs/errors';
import {
  buildCapabilities,
  findings as f,
  hasScopes,
  ProviderTimeoutError,
  ProviderTransportError,
  restrictCapabilities,
  scopeRestriction,
  type CapabilityContext,
  type ConnectionIdentity,
  type ProviderDestination,
  type SocialProviderAdapter,
} from '@gs/provider-kit';

import { mockStore } from './store.js';

/**
 * Reference adapter (plan §49).
 *
 * Proves the entire publishing engine — idempotency, leasing, retries, reconciliation,
 * partial success, webhooks — with zero network. Every behaviour here mirrors something a
 * real provider does, because an engine tested only against an always-succeeds stub is
 * untested where it matters.
 *
 * This is also the worked example a new adapter is written against, so it implements the
 * full interface including the optional methods.
 *
 * No official documentation to cite (Rule 2): there is no real platform behind this.
 */

export const MOCK_ADAPTER_VERSION = '1.0.0';

const REQUIRED_PUBLISH_SCOPES = ['post.write'];
const MAX_TEXT_LENGTH = 500;
const MAX_MEDIA_COUNT = 4;
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const SUPPORTED_VIDEO_TYPES = ['video/mp4', 'video/quicktime'];

/** Simulated latency, so timing-dependent engine code is not accidentally trivialized. */
const SIMULATED_LATENCY_MS = 5;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderTimeoutError('mock', 0));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderTimeoutError('mock', ms));
      },
      { once: true },
    );
  });
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'mock',
    adapterVersion: MOCK_ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      text_only: true,
      image: true,
      video: true,
      carousel: true,
      link_preview: true,
      thread: true,
    },
    actions: {
      delete_post: true,
      comments_read: true,
      analytics_read: true,
    },
    constraints: {
      max_text_length: MAX_TEXT_LENGTH,
      max_media_count: MAX_MEDIA_COUNT,
      max_image_bytes: 8 * 1024 * 1024,
      max_video_bytes: 128 * 1024 * 1024,
      max_video_duration_seconds: 300,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supported_video_types: SUPPORTED_VIDEO_TYPES,
      supports_alt_text: true,
    },
  });
}

/**
 * Simulated provider failure.
 *
 * Carries a `scenario` so `normalizeError` can map it deterministically, exactly as a real
 * adapter maps a provider's own status codes and error bodies.
 */
class MockProviderError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'MockProviderError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function createMockAdapter(): SocialProviderAdapter {
  return {
    provider: 'mock',
    version: MOCK_ADAPTER_VERSION,
    authStrategy: 'api_key',
    providerApiVersion: null,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      // Effective capability narrows generic by what this connection actually holds
      // (plan §17). The restriction list is what makes the narrowing explainable.
      const granted = context.grantedScopes ?? mockStore.grantedScopes;
      const restrictions = [];

      if (!hasScopes(granted, REQUIRED_PUBLISH_SCOPES)) {
        restrictions.push(
          scopeRestriction('publishing.text_only', REQUIRED_PUBLISH_SCOPES),
          scopeRestriction('publishing.image', REQUIRED_PUBLISH_SCOPES),
          scopeRestriction('publishing.video', REQUIRED_PUBLISH_SCOPES),
          scopeRestriction('publishing.carousel', REQUIRED_PUBLISH_SCOPES),
        );
      }

      if (!granted.includes('analytics.read')) {
        restrictions.push(scopeRestriction('actions.analytics_read', ['analytics.read']));
      }

      return restrictCapabilities(generic, restrictions);
    },

    auth: {
      async createAuthorization(input) {
        // `api_key` needs no redirect, but the connect flow still calls this uniformly.
        // Returning a URL the hosted UI can render keeps the flow branch-free (plan §22).
        return {
          authorizationUrl: `https://mock.invalid/authorize?state=${encodeURIComponent(input.state)}`,
          state: input.state,
        };
      },

      async exchangeCallback(input) {
        const key = input.query.key ?? 'mock-api-key';
        return {
          credentials: {
            strategy: 'api_key',
            secret: key,
            externalAccountId: 'mock_account_1',
            grantedScopes: mockStore.grantedScopes,
            metadata: {},
          },
          identity: {
            externalAccountId: 'mock_account_1',
            displayName: 'Mock Account',
            handle: '@mock',
            avatarUrl: null,
            accountType: mockStore.accountType,
            grantedScopes: mockStore.grantedScopes,
          },
        };
      },

      /**
       * Refresh, in every shape the health engine has to handle (plan §42).
       *
       * The default is a no-op: an api_key credential does not expire, and reporting
       * `rotated: false` lets the engine skip a pointless re-encrypt and write.
       *
       * The other modes exist so the refresh engine can be tested at all. Rotation
       * specifically is the case worth exercising, because most OAuth providers invalidate
       * the old refresh token the instant a new one is issued — which is what makes a
       * concurrent refresh destructive rather than merely wasteful.
       */
      async refresh(input) {
        const mode = mockStore.currentBehaviour().refresh;

        if (mode === 'expired') throw new MockProviderError('Refresh token expired.', 401);
        if (mode === 'revoked') throw new MockProviderError('Access revoked.', 403);
        if (mode === 'unavailable') throw new MockProviderError('Upstream unavailable.', 503);

        if (mode === 'rotate') {
          const issued = mockStore.rotateCredentials();
          return {
            credentials: {
              ...input.credentials,
              accessToken: issued.accessToken,
              refreshToken: issued.refreshToken,
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
            rotated: true,
          };
        }

        return { credentials: input.credentials, rotated: false };
      },

      async revoke() {
        // Nothing upstream to call. Revocation is recorded by the engine.
      },

      async inspect(input): Promise<ConnectionIdentity> {
        await delay(SIMULATED_LATENCY_MS, input.context.signal);
        return {
          externalAccountId: input.credentials.externalAccountId ?? 'mock_account_1',
          displayName: 'Mock Account',
          handle: '@mock',
          avatarUrl: null,
          accountType: mockStore.accountType,
          grantedScopes: input.credentials.grantedScopes,
        };
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        await delay(SIMULATED_LATENCY_MS, input.context.signal);
        input.context.log({
          operation: 'listDestinations',
          method: 'GET',
          path: '/mock/destinations',
          status: 200,
          durationMs: SIMULATED_LATENCY_MS,
        });

        // Two destinations, because one connection yielding several is the case the
        // schema separates connection from destination for (plan §8.5).
        return [
          {
            externalId: 'mock_dst_primary',
            displayName: 'Mock Primary Feed',
            handle: '@mock',
            avatarUrl: null,
            kind: 'feed',
            metadata: {},
          },
          {
            externalId: 'mock_dst_secondary',
            displayName: 'Mock Secondary Feed',
            handle: '@mock-secondary',
            avatarUrl: null,
            kind: 'feed',
            metadata: {},
          },
        ];
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call at all — plan §18 forbids side effects here, and the
        // certification harness asserts it by inspecting the call log.
        const { content } = input;
        const results: ValidationFinding[] = [];

        results.push(
          ...f.collect(
            f.checkTextLength(content.text, MAX_TEXT_LENGTH, {
              code: 'TEXT_TOO_LONG',
              truncatable: true,
            }),
            f.checkMediaCount(content.media.length, MAX_MEDIA_COUNT),
          ),
        );

        content.media.forEach((item, index) => {
          const supported =
            item.kind === 'video' ? SUPPORTED_VIDEO_TYPES : SUPPORTED_IMAGE_TYPES;
          const maxBytes = item.kind === 'video' ? 128 * 1024 * 1024 : 8 * 1024 * 1024;

          results.push(
            ...f.collect(
              f.checkMediaType(item.mimeType, supported, index),
              f.checkMediaSize(item.bytes, maxBytes, index),
              item.kind === 'video'
                ? f.checkVideoDuration(item.durationSeconds, { min: null, max: 300 }, index)
                : null,
            ),
          );
        });

        if (content.text.trim() === '' && content.media.length === 0) {
          results.push(
            f.error('EMPTY_POST', 'A post needs text or at least one media item.', {
              field: 'content',
              agentAction: 'add_text_or_media',
            }),
          );
        }

        // A warning, not an error: it publishes, just not as the author expects. Plan P16
        // says the product teaches rather than requiring users to know this.
        const estimatedTransformations = [];
        if (content.linkUrl && content.media.length > 0) {
          results.push(
            f.warning('LINK_PREVIEW_SUPPRESSED', 'Media takes precedence; the link preview is not shown.', {
              field: 'content.link_url',
              agentAction: 'remove_media_to_show_link_preview',
            }),
          );
          estimatedTransformations.push(
            f.transformation('link_shortened', 'The link is appended to the text instead.', 'content.link_url'),
          );
        }

        return { findings: results, estimatedTransformations };
      },

      async prepare(input) {
        await delay(SIMULATED_LATENCY_MS, input.context.signal);

        const providerMediaIds = input.content.media.map(
          (item, index) => `mock_media_${input.target.postTargetId}_${index}`,
        );

        input.context.log({
          operation: 'prepare',
          method: 'POST',
          path: '/mock/media',
          status: 200,
          durationMs: SIMULATED_LATENCY_MS,
        });

        return { state: { preparedAt: new Date().toISOString() }, providerMediaIds };
      },

      async publish(input) {
        await delay(SIMULATED_LATENCY_MS, input.context.signal);

        const behaviour = mockStore.consumeBehaviour();
        const now = new Date().toISOString();

        // The subtle one: record the post BEFORE throwing, so reconciliation can find the
        // orphan. This is precisely the real-world hazard plan §2.2 describes — the post
        // exists, the caller has no idea, and a blind retry duplicates it.
        if (behaviour === 'timeout_after_side_effect') {
          const externalPostId = mockStore.nextPostId();
          mockStore.record({
            externalPostId,
            externalUrl: `https://mock.invalid/p/${externalPostId}`,
            destinationExternalId: input.target.destinationExternalId,
            idempotencyKey: input.idempotencyKey,
            text: input.content.text,
            publishedAt: now,
          });
          throw new ProviderTimeoutError('publish', 15_000);
        }

        if (behaviour === 'timeout_no_side_effect') {
          throw new ProviderTimeoutError('publish', 15_000);
        }

        if (behaviour === 'rate_limited') {
          throw new MockProviderError(
            'Too many requests.',
            429,
            mockStore.currentBehaviour().retryAfterSeconds,
          );
        }
        if (behaviour === 'auth_expired') throw new MockProviderError('Token expired.', 401);
        if (behaviour === 'auth_revoked') throw new MockProviderError('Access revoked.', 403);
        if (behaviour === 'unavailable') throw new MockProviderError('Upstream unavailable.', 503);
        if (behaviour === 'content_rejected') {
          throw new MockProviderError('Content violates mock policy.', 422);
        }

        const externalPostId = mockStore.nextPostId();
        const externalUrl = `https://mock.invalid/p/${externalPostId}`;
        const processing = behaviour === 'processing';

        mockStore.record({
          externalPostId,
          externalUrl,
          destinationExternalId: input.target.destinationExternalId,
          idempotencyKey: input.idempotencyKey,
          text: input.content.text,
          publishedAt: now,
          processingUntil: processing ? Date.now() + mockStore.currentBehaviour().processingMs : undefined,
        });

        input.context.log({
          operation: 'publish',
          method: 'POST',
          path: '/mock/posts',
          status: processing ? 202 : 201,
          durationMs: SIMULATED_LATENCY_MS,
        });

        return processing
          ? {
              outcome: 'processing',
              externalPostId,
              externalUrl: null,
              publishedAt: null,
              statusHandle: externalPostId,
              metadata: {},
            }
          : {
              outcome: 'published',
              externalPostId,
              externalUrl,
              publishedAt: now,
              metadata: {},
            };
      },

      async status(input) {
        await delay(SIMULATED_LATENCY_MS, input.context.signal);
        const post = mockStore.get(input.statusHandle);

        if (!post) {
          return { outcome: 'failed', externalPostId: null, externalUrl: null, publishedAt: null, failureReason: 'Post not found.' };
        }

        const stillProcessing = post.processingUntil !== undefined && Date.now() < post.processingUntil;

        return stillProcessing
          ? { outcome: 'processing', externalPostId: post.externalPostId, externalUrl: null, publishedAt: null }
          : {
              outcome: 'published',
              externalPostId: post.externalPostId,
              externalUrl: post.externalUrl,
              publishedAt: post.publishedAt,
            };
      },

      async findPossibleDuplicate(input) {
        await delay(SIMULATED_LATENCY_MS, input.context.signal);

        const existing = mockStore.findByIdempotencyKey(
          input.target.destinationExternalId,
          input.idempotencyKey,
          input.attemptedAfter,
        );

        input.context.log({
          operation: 'findPossibleDuplicate',
          method: 'GET',
          path: '/mock/posts',
          status: 200,
          durationMs: SIMULATED_LATENCY_MS,
        });

        if (existing) {
          return {
            conclusion: 'found',
            externalPostId: existing.externalPostId,
            externalUrl: existing.externalUrl,
            publishedAt: existing.publishedAt,
          };
        }

        // The mock can see its own complete history, so absence here is provable. A real
        // adapter that can only read a truncated recent-posts window must return
        // `indeterminate` instead of assuming absence (Rule 14).
        return { conclusion: 'absent' };
      },

      async delete(input) {
        await delay(SIMULATED_LATENCY_MS, input.context.signal);
        const removed = mockStore.delete(input.externalPostId);
        // Deleting twice must not be an error (P4 effective-once).
        return { alreadyAbsent: !removed };
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      // Must never throw: this runs on the failure path, and an exception here means the
      // attempt record is never written.
      if (error instanceof ProviderTimeoutError) {
        return {
          code: 'PROVIDER_TIMEOUT',
          message: `Mock provider timed out during ${context.operation}.`,
        };
      }

      if (error instanceof ProviderTransportError) {
        return {
          code: 'PROVIDER_UNAVAILABLE',
          message: `Mock provider was unreachable during ${context.operation}.`,
        };
      }

      if (error instanceof MockProviderError) {
        switch (error.status) {
          case 401:
            return { code: 'AUTH_EXPIRED', message: error.message, status: 401 };
          case 403:
            return { code: 'AUTH_REVOKED', message: error.message, status: 403 };
          case 422:
            return { code: 'CONTENT_REJECTED', message: error.message, status: 422 };
          case 429:
            return {
              code: 'RATE_LIMITED',
              message: error.message,
              status: 429,
              retryAfter:
                error.retryAfterSeconds === undefined
                  ? undefined
                  : new Date(Date.now() + error.retryAfterSeconds * 1000).toISOString(),
            };
          case 503:
            return { code: 'PROVIDER_UNAVAILABLE', message: error.message, status: 503 };
        }
      }

      // Shape-matched fallbacks, so the certification harness's status-code samples
      // normalize the way a real adapter's would.
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = Number((error as { status: unknown }).status);
        if (status === 401) return { code: 'AUTH_EXPIRED', message: 'Unauthorized.', status };
        if (status === 403) return { code: 'AUTH_REVOKED', message: 'Forbidden.', status };
        if (status === 429) return { code: 'RATE_LIMITED', message: 'Rate limited.', status };
        if (status >= 500) return { code: 'PROVIDER_UNAVAILABLE', message: 'Upstream error.', status };
      }

      // Rule 14 — an unrecognized failure is NOT auto-retried, because a retry could
      // duplicate a post we cannot prove did not publish.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized mock provider failure during ${context.operation}.`,
      };
    },
  };
}
