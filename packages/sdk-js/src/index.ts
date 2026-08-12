import { HttpClient, type ClientOptions } from './client.js';
import {
  ConnectionsResource,
  IdentityResource,
  MediaResource,
  PlatformsResource,
  PostsResource,
  ProfilesResource,
  WebhooksResource,
} from './resources.js';

/**
 * The GainingSocial TypeScript SDK.
 *
 * ```ts
 * import { GainingSocial } from '@gs/sdk';
 *
 * const gs = new GainingSocial({ apiKey: process.env.GS_API_KEY! });
 *
 * const post = await gs.posts.create({
 *   profile_id: 'pro_...',
 *   content: { text: 'Shipping today.', media_ids: [] },
 *   targets: [{ destination_id: 'dst_...' }],
 * });
 * ```
 *
 * Three things worth knowing before writing against it:
 *
 *   `posts.create` returns a queued post, not a published one. Publishing happens on a
 *   queue, so nothing in this SDK will ever hand back a `published` status directly —
 *   subscribe to a webhook or poll `posts.get`.
 *
 *   Errors are one type. `GainingSocialError` carries the API's whole envelope, including
 *   `retryable` and `agent_action`. Branch on `code`, never on `message`.
 *
 *   Retries are automatic but only where they are safe. The SDK retries what the API marks
 *   retryable, honours `Retry-After`, and reuses one idempotency key across attempts so a
 *   retry can never become a second post.
 */
export class GainingSocial {
  readonly profiles: ProfilesResource;
  readonly connections: ConnectionsResource;
  readonly posts: PostsResource;
  readonly media: MediaResource;
  readonly platforms: PlatformsResource;
  readonly webhooks: WebhooksResource;
  readonly identity: IdentityResource;

  constructor(options: ClientOptions) {
    const http = new HttpClient(options);

    this.profiles = new ProfilesResource(http);
    this.connections = new ConnectionsResource(http);
    this.posts = new PostsResource(http);
    this.media = new MediaResource(http);
    this.platforms = new PlatformsResource(http);
    this.webhooks = new WebhooksResource(http);
    this.identity = new IdentityResource(http);
  }
}

export { GainingSocialError, isGainingSocialError } from './errors.js';
export { DEFAULT_BASE_URL, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from './client.js';
export type { ClientOptions, RequestOptions } from './client.js';
export { autoPaginate } from './pagination.js';
export type { ListParams, ListResponse } from './pagination.js';
export type {
  ConnectionsResource,
  IdentityResource,
  MediaResource,
  PlatformsResource,
  PostsResource,
  ProfilesResource,
  WebhooksResource,
} from './resources.js';

/**
 * Contract types re-exported so a caller never needs a second dependency to type a
 * request body or a response.
 */
export type {
  Connection,
  CreatePostRequest,
  CreateProfileRequest,
  Destination,
  Media,
  MeResponse,
  Post,
  Profile,
  UpdateProfileRequest,
  WebhookEndpoint,
  WebhookEventType,
} from '@gs/contracts/http';
export type { ProviderCapabilities } from '@gs/contracts/capabilities';
export type { ProviderName } from '@gs/contracts/providers';
