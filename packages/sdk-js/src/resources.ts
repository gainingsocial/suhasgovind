import type { ProviderCapabilities } from '@gs/contracts/capabilities';
import type {
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
} from '@gs/contracts/http';
import type { ProviderName } from '@gs/contracts/providers';

import type { HttpClient, RequestOptions } from './client.js';
import { autoPaginate, type ListParams, type ListResponse } from './pagination.js';

/**
 * The resource surface.
 *
 * One class per noun in the API, methods named for what they do rather than for their
 * HTTP verb — `gs.posts.cancel(id)` reads better than `gs.posts.post(id, 'cancel')`, and
 * the caller should not have to know that disconnecting is a POST.
 *
 * Every list method has an `autoList` twin that pages transparently. Both exist because
 * dashboards want one page and scripts want all of them, and forcing either to emulate
 * the other is how off-by-one pagination bugs get written.
 */

/** Anything a target can be composed against. Mirrors the request contract. */
export type { CreatePostRequest, CreateProfileRequest, UpdateProfileRequest };

abstract class Resource {
  protected constructor(protected readonly http: HttpClient) {}
}

export class ProfilesResource extends Resource {
  constructor(http: HttpClient) {
    super(http);
  }

  /** A publishing tenant — an end customer, a brand, a client (plan §8.2). */
  async create(body: CreateProfileRequest, options: RequestOptions = {}): Promise<Profile> {
    return this.http.request<Profile>({ method: 'POST', path: 'v1/profiles', body, ...options });
  }

  async get(profileId: string, options: RequestOptions = {}): Promise<Profile> {
    return this.http.request<Profile>({ method: 'GET', path: `v1/profiles/${profileId}`, ...options });
  }

  async update(
    profileId: string,
    body: UpdateProfileRequest,
    options: RequestOptions = {},
  ): Promise<Profile> {
    return this.http.request<Profile>({
      method: 'PATCH',
      path: `v1/profiles/${profileId}`,
      body,
      ...options,
    });
  }

  async delete(profileId: string, options: RequestOptions = {}): Promise<{ deleted: boolean }> {
    return this.http.request({ method: 'DELETE', path: `v1/profiles/${profileId}`, ...options });
  }

  async list(params: ListParams = {}, options: RequestOptions = {}): Promise<ListResponse<Profile>> {
    return this.http.request<ListResponse<Profile>>({
      method: 'GET',
      path: 'v1/profiles',
      query: { ...params },
      ...options,
    });
  }

  autoList(params: ListParams = {}, options: RequestOptions = {}): AsyncGenerator<Profile> {
    return autoPaginate((page) => this.list(page, options), params);
  }
}

export class ConnectionsResource extends Resource {
  constructor(http: HttpClient) {
    super(http);
  }

  /**
   * Begin connecting a social account.
   *
   * Returns either an `authorization_url` to send the user to, or a list of credential
   * fields to collect — the platform decides which (plan §21). A caller that assumes OAuth
   * cannot connect Bluesky, Telegram or Discord.
   */
  async authorize(
    body: { profile_id: string; provider: ProviderName; redirect_url?: string; scopes?: string[] },
    options: RequestOptions = {},
  ): Promise<{
    connection_id: string;
    completion: 'redirect' | 'credential';
    authorization_url?: string;
    required_credential_fields?: { name: string; label: string; secret: boolean }[];
  }> {
    return this.http.request({
      method: 'POST',
      path: 'v1/connections/authorize',
      body,
      ...options,
    });
  }

  /** Finish a `completion: "credential"` connection by supplying the collected fields. */
  async complete(
    body: { connection_id: string; credentials: Record<string, string> },
    options: RequestOptions = {},
  ): Promise<Connection> {
    return this.http.request<Connection>({
      method: 'POST',
      path: 'v1/connections/complete',
      body,
      ...options,
    });
  }

  async get(connectionId: string, options: RequestOptions = {}): Promise<Connection> {
    return this.http.request<Connection>({
      method: 'GET',
      path: `v1/connections/${connectionId}`,
      ...options,
    });
  }

  async list(
    params: ListParams & { profile_id?: string; provider?: ProviderName } = {},
    options: RequestOptions = {},
  ): Promise<ListResponse<Connection>> {
    return this.http.request<ListResponse<Connection>>({
      method: 'GET',
      path: 'v1/connections',
      query: { ...params },
      ...options,
    });
  }

  autoList(
    params: ListParams & { profile_id?: string; provider?: ProviderName } = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Connection> {
    return autoPaginate((page) => this.list({ ...params, ...page }, options), params);
  }

  /** Publishable surfaces behind a connection — Pages, boards, channels (plan §8.5). */
  async destinations(
    connectionId: string,
    params: ListParams = {},
    options: RequestOptions = {},
  ): Promise<ListResponse<Destination>> {
    return this.http.request<ListResponse<Destination>>({
      method: 'GET',
      path: `v1/connections/${connectionId}/destinations`,
      query: { ...params },
      ...options,
    });
  }

  /** Choose which destinations to publish to, when a connection exposes several. */
  async selectDestinations(
    connectionId: string,
    body: { destination_external_ids: string[] },
    options: RequestOptions = {},
  ): Promise<ListResponse<Destination>> {
    return this.http.request<ListResponse<Destination>>({
      method: 'POST',
      path: `v1/connections/${connectionId}/destinations/select`,
      body,
      ...options,
    });
  }

  async refresh(connectionId: string, options: RequestOptions = {}): Promise<Connection> {
    return this.http.request<Connection>({
      method: 'POST',
      path: `v1/connections/${connectionId}/refresh`,
      ...options,
    });
  }

  async disconnect(connectionId: string, options: RequestOptions = {}): Promise<{ disconnected: boolean }> {
    return this.http.request({
      method: 'POST',
      path: `v1/connections/${connectionId}/disconnect`,
      ...options,
    });
  }

  /**
   * A signed, short-lived URL hosting the whole connect flow under your branding.
   *
   * The end user never sees this dashboard and never needs an account here (plan §22).
   */
  async createSession(
    body: {
      profile_id: string;
      providers?: ProviderName[];
      redirect_url?: string;
      branding?: Record<string, unknown>;
      expires_in_seconds?: number;
    },
    options: RequestOptions = {},
  ): Promise<{ url: string; expires_at: string; connect_session_id: string }> {
    return this.http.request({ method: 'POST', path: 'v1/connect-sessions', body, ...options });
  }
}

export class PostsResource extends Resource {
  constructor(http: HttpClient) {
    super(http);
  }

  /**
   * Compose and queue a post.
   *
   * Returns 202 with the post in `queued` or `scheduled` — never `published`. Publishing
   * happens on a queue (plan §85 Rule 10), so a caller that waits for a published status
   * from this call waits forever. Subscribe to a webhook or poll `get`.
   *
   * An `Idempotency-Key` is required by the API and generated automatically when not
   * supplied. Pass your own when the caller has a stable notion of "the same request" —
   * a retry of *your* job must reuse the key, or it becomes a second post.
   */
  async create(body: CreatePostRequest, options: RequestOptions = {}): Promise<Post> {
    return this.http.request<Post>({
      method: 'POST',
      path: 'v1/posts',
      body,
      requiresIdempotencyKey: true,
      ...options,
    });
  }

  /**
   * Validate without publishing (plan §18).
   *
   * Free of side effects and safe to call as often as you like — this is the call that
   * replaces the compose-submit-reject-guess loop.
   */
  async preflight(
    body: CreatePostRequest,
    options: RequestOptions = {},
  ): Promise<{
    valid: boolean;
    targets: {
      destination_id: string;
      provider: ProviderName;
      valid: boolean;
      errors: { code: string; message: string; field: string | null; agent_action: string }[];
      warnings: { code: string; message: string; field: string | null; agent_action: string }[];
    }[];
  }> {
    return this.http.request({ method: 'POST', path: 'v1/posts/preflight', body, ...options });
  }

  async get(postId: string, options: RequestOptions = {}): Promise<Post> {
    return this.http.request<Post>({ method: 'GET', path: `v1/posts/${postId}`, ...options });
  }

  async list(
    params: ListParams & { profile_id?: string; status?: string } = {},
    options: RequestOptions = {},
  ): Promise<ListResponse<Post>> {
    return this.http.request<ListResponse<Post>>({
      method: 'GET',
      path: 'v1/posts',
      query: { ...params },
      ...options,
    });
  }

  autoList(
    params: ListParams & { profile_id?: string; status?: string } = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Post> {
    return autoPaginate((page) => this.list({ ...params, ...page }, options), params);
  }

  async cancel(postId: string, options: RequestOptions = {}): Promise<Post> {
    return this.http.request<Post>({ method: 'POST', path: `v1/posts/${postId}/cancel`, ...options });
  }

  /** Retry every failed target on a post. */
  async retry(postId: string, options: RequestOptions = {}): Promise<Post> {
    return this.http.request<Post>({ method: 'POST', path: `v1/posts/${postId}/retry`, ...options });
  }

  /** Retry one target — the usual case, when a single platform failed. */
  async retryTarget(postId: string, targetId: string, options: RequestOptions = {}): Promise<Post> {
    return this.http.request<Post>({
      method: 'POST',
      path: `v1/posts/${postId}/targets/${targetId}/retry`,
      ...options,
    });
  }

  /**
   * Every state change and provider attempt, in order.
   *
   * The first thing to look at when a post did not land: it shows which target failed,
   * what the provider said, and what was retried.
   */
  async timeline(
    postId: string,
    options: RequestOptions = {},
  ): Promise<{
    object: 'timeline';
    post_id: string;
    events: {
      at: string;
      type: string;
      target_id: string | null;
      provider: ProviderName | null;
      message: string;
      detail: Record<string, unknown>;
    }[];
  }> {
    return this.http.request({ method: 'GET', path: `v1/posts/${postId}/timeline`, ...options });
  }
}

export class MediaResource extends Resource {
  constructor(http: HttpClient) {
    super(http);
  }

  /**
   * Upload a file in one call.
   *
   * Wraps the three-step protocol — request an upload URL, PUT the bytes, mark it
   * complete — because getting it wrong leaves orphaned media rows that never become
   * publishable. The bytes go straight to storage and never through the API.
   */
  async upload(
    file: Blob | ArrayBuffer | Uint8Array,
    input: { filename: string; content_type: string; alt_text?: string },
    options: RequestOptions = {},
  ): Promise<Media> {
    // `Uint8Array` and `ArrayBuffer` are both valid Blob parts at runtime everywhere this
    // SDK runs; the DOM lib that names the union is not loaded for a library targeting
    // Node and Workers alike.
    const blob = file instanceof Blob ? file : new Blob([file as never], { type: input.content_type });

    const created = await this.http.request<{ media_id: string; upload_url: string }>({
      method: 'POST',
      path: 'v1/media/uploads',
      body: {
        filename: input.filename,
        content_type: input.content_type,
        bytes: blob.size,
        ...(input.alt_text !== undefined ? { alt_text: input.alt_text } : {}),
      },
      ...options,
    });

    // Direct to storage, using the signed URL. Deliberately not through `this.http` — it
    // carries an Authorization header that must never be sent to a third-party host.
    const upload = await fetch(created.upload_url, {
      method: 'PUT',
      headers: { 'content-type': input.content_type },
      body: blob,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!upload.ok) {
      throw new Error(`The storage upload failed with ${upload.status}.`);
    }

    return this.http.request<Media>({
      method: 'POST',
      path: `v1/media/uploads/${created.media_id}/complete`,
      ...options,
    });
  }

  /** Register media already hosted somewhere public, without moving the bytes. */
  async fromUrl(
    body: { url: string; alt_text?: string },
    options: RequestOptions = {},
  ): Promise<Media> {
    return this.http.request<Media>({ method: 'POST', path: 'v1/media/external', body, ...options });
  }

  async get(mediaId: string, options: RequestOptions = {}): Promise<Media> {
    return this.http.request<Media>({ method: 'GET', path: `v1/media/${mediaId}`, ...options });
  }

  async delete(mediaId: string, options: RequestOptions = {}): Promise<{ deleted: boolean }> {
    return this.http.request({ method: 'DELETE', path: `v1/media/${mediaId}`, ...options });
  }

  /** Ask whether this media is publishable to these destinations, before composing. */
  async preflight(
    body: { media_ids: string[]; destination_ids: string[] },
    options: RequestOptions = {},
  ): Promise<{
    valid: boolean;
    results: {
      media_id: string;
      destination_id: string;
      valid: boolean;
      findings: { code: string; message: string; agent_action: string }[];
    }[];
  }> {
    return this.http.request({ method: 'POST', path: 'v1/media/preflight', body, ...options });
  }
}

export class PlatformsResource extends Resource {
  constructor(http: HttpClient) {
    super(http);
  }

  /**
   * Every platform the product supports, with `available` marking which can be used today.
   *
   * Unbuilt platforms are listed deliberately, so a UI can render "coming soon" from the
   * API rather than a hard-coded list that drifts.
   */
  async list(options: RequestOptions = {}): Promise<
    ListResponse<{
      provider: ProviderName;
      display_name: string;
      auth_strategy: string | null;
      available: boolean;
      requires_provider_app: boolean;
    }>
  > {
    return this.http.request({ method: 'GET', path: 'v1/platforms', ...options });
  }

  /** What the platform can do at all. Not narrowed to any account (plan §17). */
  async capabilities(provider: ProviderName, options: RequestOptions = {}): Promise<ProviderCapabilities> {
    return this.http.request<ProviderCapabilities>({
      method: 'GET',
      path: `v1/platforms/${provider}/capabilities`,
      ...options,
    });
  }

  /**
   * What THIS destination can do — narrowed by granted scopes, account type and platform
   * approval state.
   *
   * Never infer this by intersecting generic capability with a guess about the account:
   * only the adapter knows that an unaudited TikTok client cannot post publicly at all.
   */
  async destinationCapabilities(
    destinationId: string,
    options: RequestOptions = {},
  ): Promise<ProviderCapabilities> {
    return this.http.request<ProviderCapabilities>({
      method: 'GET',
      path: `v1/destinations/${destinationId}/capabilities`,
      ...options,
    });
  }

  async health(options: RequestOptions = {}): Promise<{
    object: 'provider_health';
    providers: {
      provider: ProviderName;
      status: string;
      success_rate: number | null;
      sample_size: number;
    }[];
  }> {
    return this.http.request({ method: 'GET', path: 'v1/provider-health', ...options });
  }
}

export class WebhooksResource extends Resource {
  constructor(http: HttpClient) {
    super(http);
  }

  async create(
    body: { url: string; event_types: string[]; description?: string },
    options: RequestOptions = {},
  ): Promise<WebhookEndpoint & { secret: string }> {
    // The signing secret is returned exactly once, here. There is no endpoint that reveals
    // it again — rotate instead.
    return this.http.request({ method: 'POST', path: 'v1/webhooks', body, ...options });
  }

  async get(webhookId: string, options: RequestOptions = {}): Promise<WebhookEndpoint> {
    return this.http.request<WebhookEndpoint>({
      method: 'GET',
      path: `v1/webhooks/${webhookId}`,
      ...options,
    });
  }

  async list(
    params: ListParams = {},
    options: RequestOptions = {},
  ): Promise<ListResponse<WebhookEndpoint>> {
    return this.http.request<ListResponse<WebhookEndpoint>>({
      method: 'GET',
      path: 'v1/webhooks',
      query: { ...params },
      ...options,
    });
  }

  async update(
    webhookId: string,
    body: { url?: string; event_types?: string[]; status?: string; description?: string },
    options: RequestOptions = {},
  ): Promise<WebhookEndpoint> {
    return this.http.request<WebhookEndpoint>({
      method: 'PATCH',
      path: `v1/webhooks/${webhookId}`,
      body,
      ...options,
    });
  }

  async delete(webhookId: string, options: RequestOptions = {}): Promise<{ deleted: boolean }> {
    return this.http.request({ method: 'DELETE', path: `v1/webhooks/${webhookId}`, ...options });
  }

  async rotateSecret(webhookId: string, options: RequestOptions = {}): Promise<{ secret: string }> {
    return this.http.request({
      method: 'POST',
      path: `v1/webhooks/${webhookId}/rotate-secret`,
      ...options,
    });
  }

  /** Send a synthetic event, to prove the endpoint is reachable and verifies signatures. */
  async test(webhookId: string, options: RequestOptions = {}): Promise<{ delivered: boolean }> {
    return this.http.request({ method: 'POST', path: `v1/webhooks/${webhookId}/test`, ...options });
  }

  async deliveries(
    webhookId: string,
    params: ListParams & { status?: string } = {},
    options: RequestOptions = {},
  ): Promise<ListResponse<Record<string, unknown>>> {
    return this.http.request<ListResponse<Record<string, unknown>>>({
      method: 'GET',
      path: `v1/webhooks/${webhookId}/deliveries`,
      query: { ...params },
      ...options,
    });
  }

  async replay(deliveryId: string, options: RequestOptions = {}): Promise<{ replayed: boolean }> {
    return this.http.request({
      method: 'POST',
      path: `v1/webhook-deliveries/${deliveryId}/replay`,
      ...options,
    });
  }
}

export class IdentityResource extends Resource {
  constructor(http: HttpClient) {
    super(http);
  }

  /**
   * Who this key is, and what it may do.
   *
   * The cheapest way to check a key works and which environment it points at — `sk_test_`
   * and `sk_live_` keys are separate worlds (plan §6).
   */
  async me(options: RequestOptions = {}): Promise<MeResponse> {
    return this.http.request<MeResponse>({ method: 'GET', path: 'v1/me', ...options });
  }
}
