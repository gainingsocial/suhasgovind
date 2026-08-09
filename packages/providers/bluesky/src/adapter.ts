import type { ProviderCapabilities } from '@gs/contracts/capabilities';
import type { AdapterValidationResult, ValidationFinding } from '@gs/contracts/validation';
import type { NormalizedProviderError } from '@gs/errors';
import {
  buildCapabilities,
  findings as f,
  ProviderTimeoutError,
  ProviderTransportError,
  restrictCapabilities,
  type CapabilityContext,
  type ConnectionIdentity,
  type ProviderCallContext,
  type ProviderCredentials,
  type ProviderDestination,
  type ResolvedMedia,
  type SocialProviderAdapter,
} from '@gs/provider-kit';

import {
  AtProtoError,
  createRecord,
  createSession,
  deleteRecord,
  getAuthorFeed,
  getProfile,
  resolveHandle,
  rkeyFromUri,
  uploadBlob,
  type BlobRef,
  type Session,
} from './client.js';
import {
  ADAPTER_VERSION,
  APP_VIEW_BASE,
  DEFAULT_PDS,
  EMBED_EXTERNAL,
  EMBED_IMAGES,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  MAX_TEXT_GRAPHEMES,
  POST_COLLECTION,
  SUPPORTED_IMAGE_TYPES,
} from './constants.js';
import { countGraphemes, countUtf8Bytes, detectFacets, mentionFacet, type Facet } from './richtext.js';

/**
 * Bluesky adapter (AT Protocol).
 *
 * Official documentation consulted (Rule 2):
 *   https://docs.bsky.app/blog/create-post
 *   https://docs.bsky.app/docs/advanced-guides/posts
 *   https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json
 *   https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/embed/images.json
 *
 * Chosen as the Phase-1 reference provider (plan §62.1) because it has no developer
 * portal, no review queue and no app registration: an account and an app password are the
 * whole onboarding. That makes it the one real platform the engine can be proven against
 * without waiting weeks for an approval.
 *
 * Two things about atproto that shape this adapter:
 *
 *   Federation — a user's data lives on a Personal Data Server, which is usually
 *   bsky.social but need not be. The PDS is read from connection metadata rather than
 *   hard-coded, so a self-hosted account works.
 *
 *   Sessions, not tokens — `createSession` returns a short-lived access JWT ("expires
 *   after a few minutes") plus a longer-lived refresh JWT. The app password is the durable
 *   credential, so this adapter can always mint a fresh session rather than failing when a
 *   stored access token has gone stale.
 */

const BLUESKY_HANDLE_KEY = 'handle';
const BLUESKY_DID_KEY = 'did';
const BLUESKY_PDS_KEY = 'pds';

function pdsOf(credentials: ProviderCredentials): string {
  const value = credentials.metadata[BLUESKY_PDS_KEY];
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_PDS;
}

/**
 * Obtain a usable session.
 *
 * Always mints a fresh one from the app password rather than reusing a stored access JWT.
 * That looks wasteful, and it is one extra call — but the access token is documented to
 * last only minutes, so a stored one is stale far more often than not, and the failure
 * mode of using it is an `ExpiredToken` mid-publish that has to be unwound. The app
 * password never expires, which is what makes this the simpler correct choice.
 */
async function openSession(
  context: ProviderCallContext,
  credentials: ProviderCredentials,
): Promise<Session> {
  const identifier = credentials.metadata[BLUESKY_HANDLE_KEY];
  const password = credentials.secret;

  if (typeof identifier !== 'string' || !password) {
    throw new AtProtoError(
      401,
      'AuthMissing',
      'This connection is missing its Bluesky handle or app password.',
    );
  }

  return createSession(context, { pds: pdsOf(credentials), identifier, password });
}

function genericCapabilities(): ProviderCapabilities {
  return buildCapabilities({
    provider: 'bluesky',
    adapterVersion: ADAPTER_VERSION,
    resolution: 'generic',
    publishing: {
      text_only: true,
      image: true,
      // No video in `app.bsky.embed.images`. Bluesky has since shipped video through a
      // separate embed; claiming support before this adapter implements it would make
      // preflight approve posts that then fail (Rule 2 — do not assume).
      carousel: true,
      link_preview: true,
      thread: true,
    },
    actions: {
      delete_post: true,
      comments_read: true,
    },
    constraints: {
      // Both limits are real and measure different things. See constants.ts.
      max_text_length: MAX_TEXT_GRAPHEMES,
      max_media_count: MAX_IMAGES,
      max_image_bytes: MAX_IMAGE_BYTES,
      supported_image_types: SUPPORTED_IMAGE_TYPES,
      supports_alt_text: true,
    },
  });
}

/** Fetch media bytes so they can be uploaded as a blob. */
async function fetchMedia(context: ProviderCallContext, media: ResolvedMedia): Promise<ArrayBuffer> {
  const response = await fetch(media.downloadUrl, { signal: context.signal });
  if (!response.ok) {
    throw new AtProtoError(response.status, 'MediaFetchFailed', 'Could not read the media file.');
  }
  return response.arrayBuffer();
}

export function createBlueskyAdapter(): SocialProviderAdapter {
  return {
    provider: 'bluesky',
    version: ADAPTER_VERSION,
    // Plan §20. No OAuth, no registered app — which is exactly why it ships first.
    authStrategy: 'app_password',
    // atproto Lexicons are versioned individually rather than by an API-wide version.
    providerApiVersion: null,

    async capabilities(context?: CapabilityContext): Promise<ProviderCapabilities> {
      const generic = genericCapabilities();
      if (!context) return generic;

      // An app password grants everything this adapter does — atproto has no scope model
      // to narrow against — so effective capability equals generic. Returning it through
      // `restrictCapabilities` keeps `resolution: 'effective'` honest.
      return restrictCapabilities(generic, []);
    },

    auth: {
      async createAuthorization(input) {
        // No consent screen exists. The hosted connect UI collects a handle and app
        // password directly; this URL is where it sends the user to create one.
        return {
          authorizationUrl: 'https://bsky.app/settings/app-passwords',
          state: input.state,
        };
      },

      async exchangeCallback(input) {
        const identifier = input.query.identifier ?? input.query.handle;
        const password = input.query.password ?? input.query.app_password;

        if (!identifier || !password) {
          throw new AtProtoError(
            400,
            'InvalidRequest',
            'A Bluesky handle and app password are both required.',
          );
        }

        const session = await createSession(input.context, {
          pds: input.query.pds,
          identifier,
          password,
        });

        const profile = await getProfile(input.context, {
          pds: input.query.pds,
          accessJwt: session.accessJwt,
          actor: session.did,
        }).catch(() => null);

        return {
          credentials: {
            strategy: 'app_password',
            // The app password is the stored credential, not the session JWTs. Sessions
            // are minted per publish; storing a token that expires in minutes would mean
            // storing something already stale.
            secret: password,
            externalAccountId: session.did,
            grantedScopes: [],
            metadata: {
              [BLUESKY_HANDLE_KEY]: session.handle,
              [BLUESKY_DID_KEY]: session.did,
              ...(input.query.pds ? { [BLUESKY_PDS_KEY]: input.query.pds } : {}),
            },
          },
          identity: {
            externalAccountId: session.did,
            displayName: profile?.displayName ?? session.handle,
            handle: session.handle,
            avatarUrl: profile?.avatar ?? null,
            accountType: null,
            grantedScopes: [],
          },
        };
      },

      async refresh(input) {
        // Nothing to rotate: the app password is the credential and it does not expire.
        // Reporting `rotated: false` lets the engine skip a pointless re-encrypt.
        return { credentials: input.credentials, rotated: false };
      },

      async revoke() {
        // A server-side session could be deleted, but this adapter does not keep one
        // between publishes. Revocation is the user deleting the app password in Bluesky's
        // settings — which we cannot do for them, and should not.
      },

      async inspect(input): Promise<ConnectionIdentity> {
        const session = await openSession(input.context, input.credentials);
        const profile = await getProfile(input.context, {
          pds: pdsOf(input.credentials),
          accessJwt: session.accessJwt,
          actor: session.did,
        }).catch(() => null);

        return {
          externalAccountId: session.did,
          displayName: profile?.displayName ?? session.handle,
          handle: session.handle,
          avatarUrl: profile?.avatar ?? null,
          accountType: null,
          grantedScopes: [],
        };
      },
    },

    destinations: {
      async list(input): Promise<ProviderDestination[]> {
        const session = await openSession(input.context, input.credentials);
        const profile = await getProfile(input.context, {
          pds: pdsOf(input.credentials),
          accessJwt: session.accessJwt,
          actor: session.did,
        }).catch(() => null);

        // Exactly one destination, always. A Bluesky account has a single feed — there is
        // no equivalent of a Meta Page. The destination still exists as its own object so
        // the engine's model stays uniform (plan §8.5).
        return [
          {
            externalId: session.did,
            displayName: profile?.displayName ?? session.handle,
            handle: session.handle,
            avatarUrl: profile?.avatar ?? null,
            kind: 'feed',
            metadata: { [BLUESKY_HANDLE_KEY]: session.handle },
          },
        ];
      },
    },

    publishing: {
      async validate(input): Promise<AdapterValidationResult> {
        // No network call. Plan §18 forbids side effects here, and the certification
        // harness asserts it by inspecting the call log.
        const { content } = input;
        const results: ValidationFinding[] = [];

        const graphemes = countGraphemes(content.text);
        if (graphemes > MAX_TEXT_GRAPHEMES) {
          results.push(
            f.error(
              'TEXT_TOO_LONG',
              `Bluesky allows ${MAX_TEXT_GRAPHEMES} characters; this post has ${graphemes}.`,
              {
                field: 'content.text',
                agentAction: 'shorten_text',
                autofix: {
                  kind: 'truncate_text',
                  description: `Truncate to ${MAX_TEXT_GRAPHEMES} characters.`,
                  parameters: { max_length: MAX_TEXT_GRAPHEMES },
                },
              },
            ),
          );
        }

        // The byte ceiling is separate and can bind first: 300 emoji pass the grapheme
        // check and blow the 3000-byte limit. Checking only the famous number would let
        // the provider reject a post preflight approved.
        const bytes = countUtf8Bytes(content.text);
        if (bytes > MAX_TEXT_BYTES) {
          results.push(
            f.error('TEXT_TOO_LONG', `Post text is ${bytes} bytes; Bluesky allows ${MAX_TEXT_BYTES}.`, {
              field: 'content.text',
              agentAction: 'shorten_text',
            }),
          );
        }

        if (content.text.trim() === '' && content.media.length === 0) {
          results.push(
            f.error('TEXT_REQUIRED', 'A Bluesky post needs text or at least one image.', {
              field: 'content',
              agentAction: 'add_text_or_media',
            }),
          );
        }

        results.push(...f.collect(f.checkMediaCount(content.media.length, MAX_IMAGES)));

        content.media.forEach((item, index) => {
          if (item.kind === 'video') {
            results.push(
              f.error('MEDIA_TYPE_UNSUPPORTED', 'This adapter does not publish video to Bluesky yet.', {
                field: `media[${index}]`,
                agentAction: 'remove_video_or_choose_another_destination',
              }),
            );
            return;
          }

          results.push(
            ...f.collect(
              f.checkMediaType(item.mimeType, SUPPORTED_IMAGE_TYPES, index),
              f.checkMediaSize(item.bytes, MAX_IMAGE_BYTES, index),
            ),
          );

          if (!item.altText) {
            // A warning, not an error. Bluesky's own client nags for alt text and its
            // community expects it, but a missing description must not block a post.
            results.push(
              f.warning('MEDIA_ALT_TEXT_MISSING', 'Bluesky users expect alt text on images.', {
                field: `media[${index}]`,
                agentAction: 'add_alt_text',
              }),
            );
          }
        });

        const estimatedTransformations = [];
        if (content.linkUrl && content.media.length > 0) {
          // A post carries one embed. Images win, so the link cannot also render a card.
          estimatedTransformations.push(
            f.transformation(
              'link_shortened',
              'Images take the embed slot, so the link will appear as text rather than a preview card.',
              'content.link_url',
            ),
          );
        }

        return { findings: results, estimatedTransformations };
      },

      async prepare(input) {
        const session = await openSession(input.context, input.credentials);
        const pds = pdsOf(input.credentials);

        // Blobs are uploaded here rather than in `publish` so the expensive, retry-prone
        // work is separated from the single irreversible act. A failed upload can be
        // retried freely; a failed createRecord cannot.
        const blobs: BlobRef[] = [];
        for (const media of input.content.media) {
          if (media.kind === 'video') continue;
          const bytes = await fetchMedia(input.context, media);
          blobs.push(
            await uploadBlob(input.context, {
              pds,
              accessJwt: session.accessJwt,
              bytes,
              mimeType: media.mimeType,
            }),
          );
        }

        return {
          state: {
            did: session.did,
            accessJwt: session.accessJwt,
            blobs: blobs as unknown as Record<string, unknown>[],
          },
          providerMediaIds: blobs.map((blob) => blob.ref.$link),
        };
      },

      async publish(input) {
        const pds = pdsOf(input.credentials);
        const state = input.prepared.state as { did?: string; accessJwt?: string; blobs?: BlobRef[] };

        // The prepared session may have aged out between prepare and publish — the access
        // JWT lasts minutes and a queue can delay in between. Minting a fresh one is
        // cheaper than discovering it expired at the moment of the irreversible call.
        const session = await openSession(input.context, input.credentials);
        const blobs = state.blobs ?? [];

        const { facets, mentions } = detectFacets(input.content.text);
        const allFacets: Facet[] = [...facets];

        for (const mention of mentions) {
          const did = await resolveHandle(input.context, { pds, handle: mention.handle });
          // An unresolvable handle degrades to plain text rather than failing the post.
          if (did) allFacets.push(mentionFacet(mention, did));
        }

        const record: Record<string, unknown> = {
          $type: POST_COLLECTION,
          text: input.content.text,
          // Rule 15 — UTC ISO-8601, and required by the Lexicon.
          createdAt: new Date().toISOString(),
        };

        if (allFacets.length > 0) record.facets = allFacets;

        if (blobs.length > 0) {
          record.embed = {
            $type: EMBED_IMAGES,
            images: blobs.map((blob, index) => ({
              // Alt text is a required field on each image, so an empty string stands in
              // when the author supplied none — omitting the key fails Lexicon validation.
              alt: input.content.media[index]?.altText ?? '',
              image: blob,
            })),
          };
        } else if (input.content.linkUrl) {
          // No images, so the link can have the embed slot as a preview card. Title and
          // description are left to the app view rather than invented here.
          record.embed = {
            $type: EMBED_EXTERNAL,
            external: { uri: input.content.linkUrl, title: '', description: '' },
          };
        }

        const result = await createRecord(input.context, {
          pds,
          accessJwt: session.accessJwt,
          repo: session.did,
          collection: POST_COLLECTION,
          record,
        });

        const rkey = rkeyFromUri(result.uri);

        return {
          outcome: 'published',
          // The AT-URI is the canonical identifier. The bsky.app URL is a view of it and
          // would break if the user changed handle, so the URI is what gets stored.
          externalPostId: result.uri,
          externalUrl: rkey ? `${APP_VIEW_BASE}/profile/${session.handle}/post/${rkey}` : null,
          publishedAt: new Date().toISOString(),
          metadata: { cid: result.cid, did: session.did },
        };
      },

      async findPossibleDuplicate(input) {
        // ADR-006 Layer 4. Bluesky has no idempotency key, so after an ambiguous timeout
        // the only way to know whether the post landed is to look at the feed.
        const session = await openSession(input.context, input.credentials);
        const pds = pdsOf(input.credentials);

        const feed = await getAuthorFeed(input.context, {
          pds,
          accessJwt: session.accessJwt,
          actor: session.did,
          limit: 50,
        });

        const attemptedAfter = Date.parse(input.attemptedAfter);
        const wanted = input.content.text.trim();

        for (const entry of feed) {
          const indexedAt = Date.parse(entry.post.indexedAt);
          if (Number.isFinite(indexedAt) && indexedAt < attemptedAfter) continue;

          // Matching on exact text is the best available signal: atproto stores no
          // client-supplied idempotency key, and the record key is server-assigned.
          if ((entry.post.record.text ?? '').trim() === wanted) {
            const rkey = rkeyFromUri(entry.post.uri);
            return {
              conclusion: 'found',
              externalPostId: entry.post.uri,
              externalUrl: rkey
                ? `${APP_VIEW_BASE}/profile/${session.handle}/post/${rkey}`
                : undefined,
              publishedAt: entry.post.record.createdAt ?? entry.post.indexedAt,
            };
          }
        }

        // The feed is a window, not the whole history. If the window is full, an older
        // matching post could be just outside it, so absence is not provable — Rule 14
        // says say so rather than let the engine retry on a guess.
        if (feed.length >= 50) {
          return {
            conclusion: 'indeterminate',
            reason:
              'The author feed window was full, so an earlier matching post cannot be ruled out.',
          };
        }

        return { conclusion: 'absent' };
      },

      async delete(input) {
        const session = await openSession(input.context, input.credentials);
        const rkey = rkeyFromUri(input.externalPostId);

        if (!rkey) {
          return { alreadyAbsent: true };
        }

        try {
          await deleteRecord(input.context, {
            pds: pdsOf(input.credentials),
            accessJwt: session.accessJwt,
            repo: session.did,
            collection: POST_COLLECTION,
            rkey,
          });
          return { alreadyAbsent: false };
        } catch (error) {
          // Deleting an already-deleted record must not be an error (P4).
          if (error instanceof AtProtoError && error.status === 400) {
            return { alreadyAbsent: true };
          }
          throw error;
        }
      },
    },

    normalizeError(error, context): NormalizedProviderError {
      // Must never throw: this runs on the failure path, and an exception here means the
      // attempt record is never written.
      if (error instanceof ProviderTimeoutError) {
        return {
          code: 'PROVIDER_TIMEOUT',
          message: `Bluesky did not respond during ${context.operation}.`,
        };
      }

      if (error instanceof ProviderTransportError) {
        return {
          code: 'PROVIDER_UNAVAILABLE',
          message: `Bluesky was unreachable during ${context.operation}.`,
        };
      }

      if (error instanceof AtProtoError) {
        // Branch on the machine-readable error name first. The human message is not a
        // stable contract and Bluesky rewords it.
        switch (error.errorName) {
          case 'ExpiredToken':
          case 'AuthMissing':
          case 'AuthenticationRequired':
            return { code: 'AUTH_EXPIRED', message: error.message, status: error.status };
          case 'AccountTakedown':
          case 'AccountDeactivated':
            return { code: 'AUTH_REVOKED', message: error.message, status: error.status };
          case 'RateLimitExceeded':
            return {
              code: 'RATE_LIMITED',
              message: error.message,
              status: error.status,
              retryAfter: error.retryAfter,
            };
          case 'BlobTooLarge':
          case 'UnsupportedMimeType':
            return { code: 'MEDIA_UNSUPPORTED', message: error.message, status: error.status };
          case 'InvalidRequest':
          case 'InvalidSwap':
            return { code: 'VALIDATION_FAILED', message: error.message, status: error.status };
        }

        if (error.status === 401 || error.status === 403) {
          return { code: 'AUTH_EXPIRED', message: error.message, status: error.status };
        }
        if (error.status === 429) {
          return {
            code: 'RATE_LIMITED',
            message: error.message,
            status: error.status,
            retryAfter: error.retryAfter,
          };
        }
        if (error.status === 502 || error.status === 503 || error.status === 504) {
          return { code: 'PROVIDER_UNAVAILABLE', message: error.message, status: error.status };
        }
        if (error.status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: error.message, status: error.status };
        }
        if (error.status === 400 || error.status === 422) {
          return { code: 'VALIDATION_FAILED', message: error.message, status: error.status };
        }
      }

      // Shape-matched fallback for anything that carries a status but is not an
      // AtProtoError — a proxy error page, for instance.
      if (typeof error === 'object' && error !== null && 'status' in error) {
        const status = Number((error as { status: unknown }).status);
        if (status === 401 || status === 403) {
          return { code: 'AUTH_EXPIRED', message: 'Bluesky rejected the credentials.', status };
        }
        if (status === 429) {
          return { code: 'RATE_LIMITED', message: 'Bluesky is rate limiting this account.', status };
        }
        if (status >= 500) {
          return { code: 'PROVIDER_UNAVAILABLE', message: 'Bluesky returned a server error.', status };
        }
      }

      // Rule 14 — an unrecognized failure is NOT auto-retried, because a retry could
      // duplicate a post we cannot prove did not publish.
      return {
        code: 'UNKNOWN_PROVIDER_ERROR',
        message: `Unrecognized Bluesky failure during ${context.operation}.`,
      };
    },
  };
}
