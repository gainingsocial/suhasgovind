import type {
  AuthRedirect,
  ProviderAppCredentials,
  ProviderCallContext,
} from '@gs/provider-kit';

import { GRAPH_VERSION, GraphError, graphCall } from './graph.js';

/**
 * Facebook Login, shared by the Facebook Pages and Instagram adapters.
 *
 * https://developers.facebook.com/docs/facebook-login/guides/access-tokens
 * https://developers.facebook.com/docs/pages-api/getting-started
 *
 * Both adapters connect through the *same* Meta application and the same consent screen —
 * an Instagram Business account is reached through the Facebook Page it is linked to, so
 * there is one OAuth flow producing one user token, from which both a Page token and an
 * Instagram user id are derived. Duplicating this in two adapters would mean two chances
 * to get the long-lived token exchange wrong.
 *
 * Threads is deliberately *not* here: it is a separate app registration on a separate host
 * with its own token grammar.
 */

/**
 * Meta hands out three different tokens and they behave nothing alike:
 *
 *   short-lived user token   ~1 hour. What the OAuth callback returns.
 *   long-lived user token    ~60 days. Must be exchanged for explicitly.
 *   Page access token        derived from a long-lived user token; does not expire on a
 *                            timer, but dies the moment the user token behind it does.
 *
 * The trap is that the callback's token works perfectly in testing and then every
 * connection breaks an hour later. The exchange below is not optional.
 */
export const SHORT_LIVED_TOKEN_WARNING =
  'A Facebook Login callback returns a token valid for about an hour. It must be exchanged for a long-lived token before it is stored.';

export function buildAuthorizationUrl(input: {
  app: ProviderAppCredentials;
  state: string;
  scopes: readonly string[];
  /** Forces the permission screen again, used when re-requesting a declined scope. */
  rerequest?: boolean;
}): AuthRedirect {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', input.app.clientId);
  url.searchParams.set('redirect_uri', input.app.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', input.scopes.join(','));

  if (input.rerequest) {
    // Without this, Meta silently skips permissions the user already declined and the
    // callback succeeds with a token that cannot publish.
    url.searchParams.set('auth_type', 'rerequest');
  }

  return { authorizationUrl: url.toString(), state: input.state };
}

export interface ExchangedToken {
  readonly accessToken: string;
  /** UTC ISO-8601 (Rule 15). Absent when Meta reports the token as non-expiring. */
  readonly expiresAt: string | undefined;
  readonly grantedScopes: readonly string[];
  readonly userId: string;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

interface DebugTokenResponse {
  data?: {
    user_id?: string;
    scopes?: string[];
    expires_at?: number;
    is_valid?: boolean;
    /** Present and 0 for tokens Meta considers non-expiring, e.g. Page tokens. */
    data_access_expires_at?: number;
  };
}

/**
 * Exchange an authorization code for a long-lived user token.
 *
 * Two calls, both necessary: the code exchange returns a short-lived token, and the
 * `fb_exchange_token` grant upgrades it. Storing the first one produces connections that
 * all break about an hour after they are made.
 */
export async function exchangeCodeForLongLivedToken(
  context: ProviderCallContext,
  input: { app: ProviderAppCredentials; code: string },
): Promise<ExchangedToken> {
  const { data: short } = await graphCall<TokenResponse>(context, {
    method: 'GET',
    path: '/oauth/access_token',
    operation: 'oauth.code_exchange',
    query: {
      client_id: input.app.clientId,
      client_secret: input.app.clientSecret,
      redirect_uri: input.app.redirectUri,
      code: input.code,
    },
    // No bearer token yet — this call authenticates with the client secret itself.
    accessToken: '',
  });

  if (!short.access_token) {
    throw new GraphError(502, { message: 'Meta did not return an access token.' }, '');
  }

  return exchangeForLongLivedToken(context, { app: input.app, accessToken: short.access_token });
}

/** Upgrade any short-lived user token to the ~60-day long-lived form. */
export async function exchangeForLongLivedToken(
  context: ProviderCallContext,
  input: { app: ProviderAppCredentials; accessToken: string },
): Promise<ExchangedToken> {
  const { data: long } = await graphCall<TokenResponse>(context, {
    method: 'GET',
    path: '/oauth/access_token',
    operation: 'oauth.long_lived_exchange',
    query: {
      grant_type: 'fb_exchange_token',
      client_id: input.app.clientId,
      client_secret: input.app.clientSecret,
      fb_exchange_token: input.accessToken,
    },
    accessToken: '',
  });

  const accessToken = long.access_token;
  if (!accessToken) {
    throw new GraphError(502, { message: 'Meta did not return a long-lived access token.' }, '');
  }

  // The token response says nothing about which permissions the user actually granted, and
  // Meta lets a user tick some and untick others on the consent screen. Asking
  // `debug_token` is the only way to learn what we really hold — assuming the requested
  // scopes were granted is how an adapter ends up calling an endpoint it has no permission
  // for and reporting the resulting 403 as a platform outage.
  const inspected = await inspectToken(context, { app: input.app, accessToken });

  return {
    accessToken,
    expiresAt:
      inspected.expiresAt ??
      (long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : undefined),
    grantedScopes: inspected.grantedScopes,
    userId: inspected.userId,
  };
}

/**
 * Ask Meta what a token actually is.
 *
 * Authenticated with an app access token (`{app-id}|{app-secret}`) rather than the token
 * being inspected, because a revoked token cannot be used to discover that it is revoked.
 */
export async function inspectToken(
  context: ProviderCallContext,
  input: { app: ProviderAppCredentials; accessToken: string },
): Promise<{ userId: string; grantedScopes: readonly string[]; expiresAt: string | undefined; valid: boolean }> {
  const appToken = `${input.app.clientId}|${input.app.clientSecret}`;

  const { data } = await graphCall<DebugTokenResponse>(context, {
    method: 'GET',
    path: '/debug_token',
    operation: 'oauth.debug_token',
    query: { input_token: input.accessToken },
    accessToken: appToken,
  });

  const info = data.data ?? {};

  return {
    userId: info.user_id ?? '',
    grantedScopes: info.scopes ?? [],
    // `expires_at: 0` is Meta's way of saying "does not expire", which is not the same as
    // "expires at the Unix epoch". Treating it literally would mark every Page token as
    // expired and trigger an endless reconnect prompt.
    expiresAt: info.expires_at ? new Date(info.expires_at * 1000).toISOString() : undefined,
    valid: info.is_valid !== false,
  };
}

/**
 * Revoke every permission this app holds for the user.
 *
 * Unlike LinkedIn, Meta does offer this, and calling it on disconnect is the difference
 * between a user who is disconnected in our dashboard and one who is actually disconnected
 * at the platform.
 */
export async function revokePermissions(
  context: ProviderCallContext,
  input: { app: ProviderAppCredentials; accessToken: string },
): Promise<void> {
  await graphCall(context, {
    method: 'DELETE',
    path: '/me/permissions',
    operation: 'oauth.revoke',
    accessToken: input.accessToken,
    appSecret: input.app.clientSecret,
  });
}

export interface ManagedPage {
  readonly id: string;
  readonly name: string;
  readonly accessToken: string;
  readonly category: string | null;
  readonly pictureUrl: string | null;
  /** Permissions the user holds on this Page, e.g. `CREATE_CONTENT`. */
  readonly tasks: readonly string[];
  /** Linked Instagram professional account, when the Page has one. */
  readonly instagram: { id: string; username: string | null; pictureUrl: string | null } | null;
}

interface AccountsResponse {
  data?: {
    id: string;
    name?: string;
    access_token?: string;
    category?: string;
    tasks?: string[];
    picture?: { data?: { url?: string } };
    instagram_business_account?: {
      id: string;
      username?: string;
      profile_picture_url?: string;
    };
  }[];
  paging?: { next?: string };
}

/**
 * List the Pages this user administers, with a Page access token for each.
 *
 * One call rather than one per Page: `/me/accounts` returns the Page tokens inline, and
 * the linked Instagram account can be requested in the same field expansion. Both the
 * Facebook and Instagram adapters need this list, which is the main reason this module
 * exists.
 *
 * A Page token is what actually publishes. The user token can list Pages and nothing else,
 * so an adapter that tries to post with it gets a permission error that looks like a
 * missing scope.
 */
export async function listManagedPages(
  context: ProviderCallContext,
  input: { app: ProviderAppCredentials; accessToken: string },
): Promise<ManagedPage[]> {
  const { data } = await graphCall<AccountsResponse>(context, {
    method: 'GET',
    path: '/me/accounts',
    operation: 'listManagedPages',
    query: {
      fields:
        'id,name,access_token,category,tasks,picture{url},instagram_business_account{id,username,profile_picture_url}',
      limit: '100',
    },
    accessToken: input.accessToken,
    appSecret: input.app.clientSecret,
  });

  return (data.data ?? []).flatMap((page) => {
    // A Page with no token is one we cannot publish to. Returning it anyway would let a
    // customer select a destination that fails at publish time rather than at connect time.
    if (!page.access_token) return [];

    const ig = page.instagram_business_account;

    return [
      {
        id: page.id,
        name: page.name ?? 'Facebook Page',
        accessToken: page.access_token,
        category: page.category ?? null,
        pictureUrl: page.picture?.data?.url ?? null,
        tasks: page.tasks ?? [],
        instagram: ig
          ? { id: ig.id, username: ig.username ?? null, pictureUrl: ig.profile_picture_url ?? null }
          : null,
      },
    ];
  });
}

/**
 * Meta's task string for publishing.
 *
 * A user can administer a Page in a role that cannot post — an Analyst, for instance.
 * Checking this at connect time turns "your post failed" into "this account cannot publish
 * to that Page", which is a support ticket avoided.
 */
export const TASK_CREATE_CONTENT = 'CREATE_CONTENT';
