import { fromPublicId } from '@gs/contracts/ids';
import { requiresProviderApp } from '@gs/contracts/providers';
import { CredentialCipher, Keyring, type CREDENTIAL_ALGORITHM } from '@gs/crypto';
import {
  findConnectionCredentials,
  findDestinationOwnership,
  findMediaByIds,
  findProviderApp,
  getPostWithTargets,
  type Database,
  type MediaAsset,
  type PostTarget,
} from '@gs/db';
import { resolveTargetContent } from '@gs/domain';
import type {
  ProviderAppCredentials,
  ProviderCredentials,
  ResolvedMedia,
  ResolvedTargetContent,
} from '@gs/provider-kit';

import type { Env } from './env.js';
import { mediaStorageKey, presign } from '@gs/storage';

/**
 * Assemble everything one publish needs, in as few round trips as possible.
 *
 * Credentials are decrypted here and nowhere else, immediately before the provider call
 * (P9, §7.2). They are never logged, never persisted in decrypted form, and never
 * returned to a caller. The decrypted value lives only for the duration of the attempt.
 */

export interface BlockedReason {
  code: string;
  message: string;
}

export interface PublishContext {
  blocked?: BlockedReason;
  credentials: ProviderCredentials;
  app: ProviderAppCredentials | null;
  destinationExternalId: string;
  content: ResolvedTargetContent;
}

/** Media the provider fetches by URL. Short-lived signed reads, never public URLs (§31). */
const MEDIA_READ_TTL_SECONDS = 900;

async function signedMediaUrl(env: Env, asset: MediaAsset): Promise<string> {
  // External media already lives at a URL the customer controls, and it passed SSRF
  // validation at registration.
  if (asset.source === 'external_url' && asset.externalUrl) return asset.externalUrl;

  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) {
    throw new Error('Media cannot be signed: R2 credentials are not configured.');
  }

  const key =
    asset.storageKey ??
    mediaStorageKey({
      organizationId: asset.organizationId,
      projectEnvironmentId: asset.projectEnvironmentId,
      mediaId: asset.id,
    });

  const presigned = await presign(
    {
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
    },
    { method: 'GET', key, expiresInSeconds: MEDIA_READ_TTL_SECONDS },
  );

  return presigned.url;
}

export async function loadPublishContext(
  db: Database,
  env: Env,
  target: PostTarget,
): Promise<PublishContext> {
  const ownership = await findDestinationOwnership(db, target.destinationId);
  if (!ownership) {
    return {
      blocked: { code: 'DESTINATION_NOT_FOUND', message: 'The destination no longer exists.' },
    } as PublishContext;
  }

  // Re-checked at publish time, not trusted from when the post was created. A connection
  // can be revoked between scheduling and publishing, and a scheduled post can sit for
  // weeks — the check at creation says nothing about now.
  if (ownership.disconnectedAt) {
    return {
      blocked: { code: 'CONNECTION_DISCONNECTED', message: 'The connection was disconnected.' },
    } as PublishContext;
  }
  if (ownership.connectionHealth === 'revoked' || ownership.connectionHealth === 'reauth_required') {
    return {
      blocked: {
        code: 'CONNECTION_REAUTH_REQUIRED',
        message: 'The connection must be re-authorized before it can publish.',
      },
    } as PublishContext;
  }

  // Destination-scoped, so a provider that issues a token per surface publishes with the
  // right one. A Meta Page token is the case that makes this mandatory: the user token
  // that discovered the Page cannot post to it, and handing it over produces a permissions
  // error naming nothing useful.
  const stored = await findConnectionCredentials(db, ownership.connectionId, ownership.destinationId);
  if (!stored || stored.length === 0) {
    return {
      blocked: {
        code: 'CONNECTION_REAUTH_REQUIRED',
        message: 'No credentials are stored for this connection.',
      },
    } as PublishContext;
  }

  // Decryption happens here and only here (ADR-007). The keyring holds every version so a
  // credential encrypted under an older KEK still opens during a rotation.
  const keyring = Keyring.fromEnv({
    CREDENTIAL_KEK_V1: env.CREDENTIAL_KEK_V1,
    CREDENTIAL_KEK_V2: env.CREDENTIAL_KEK_V2,
    CREDENTIAL_KEK_ACTIVE_VERSION: env.CREDENTIAL_KEK_ACTIVE_VERSION,
  });
  const cipher = new CredentialCipher(keyring);

  const decrypted: Record<string, string> = {};
  for (const record of stored) {
    decrypted[record.credentialType] = await cipher.decrypt(
      {
        ciphertext: record.ciphertext,
        nonce: record.nonce,
        // The column is text; the cipher rejects anything it does not recognize, so a
        // mismatched value fails loudly at decryption rather than being assumed here.
        algorithm: record.algorithm as typeof CREDENTIAL_ALGORITHM,
        keyVersion: record.keyVersion,
      },
      {
        // Associated data binds the ciphertext to its tenant, its connection AND its
        // credential type: a record moved between any of those fails to decrypt rather
        // than silently working. Including the type is what stops a refresh token being
        // swapped into the access-token slot, and including the destination is what stops
        // one Page's token being used to publish to another.
        organizationId: ownership.organizationId,
        projectId: ownership.projectId,
        connectionId: ownership.connectionId,
        credentialType: record.credentialType,
        destinationId: record.destinationId,
      },
    );
  }

  const credentials: ProviderCredentials = {
    strategy: stored[0]!.authStrategy,
    accessToken: decrypted.access_token,
    refreshToken: decrypted.refresh_token,
    secret: decrypted.app_password ?? decrypted.bot_token ?? decrypted.api_key,
    tokenSecret: decrypted.oauth1_token_secret,
    externalAccountId: ownership.providerDestinationId,
    grantedScopes: stored[0]!.grantedScopes,
    metadata: stored[0]!.connectionMetadata,
  };

  // Content: canonical post, target overrides, provider options (plan §11.2). The exact
  // same resolution preflight ran, which is what makes preflight's answer trustworthy.
  const found = await getPostWithTargets(db, target.postId);
  if (!found) {
    return { blocked: { code: 'POST_NOT_FOUND', message: 'The post no longer exists.' } } as PublishContext;
  }

  const resolved = resolveTargetContent({
    canonical: found.post.content as Record<string, unknown>,
    overrides: target.overrides,
    options: target.options as Record<string, Record<string, unknown>> | null,
    provider: target.provider,
  });

  // Public ids are Crockford base32, not a prefixed UUID — decoding is required, and
  // stripping the prefix would silently produce ids that match nothing.
  const internalByPublic = new Map<string, string>();
  for (const publicId of resolved.media_ids) {
    const internal = fromPublicId('media', publicId);
    if (internal) internalByPublic.set(publicId, internal);
  }

  const mediaAssets = await findMediaByIds(db, ownership.projectEnvironmentId, [
    ...internalByPublic.values(),
  ]);

  // Resolved in the order the caller specified — carousel order is array order, and
  // shuffling it would publish the images in the wrong sequence.
  const media: ResolvedMedia[] = [];
  for (const publicId of resolved.media_ids) {
    const internalId = internalByPublic.get(publicId);
    const asset = internalId ? mediaAssets.get(internalId) : undefined;
    if (!asset) continue;

    media.push({
      mediaId: publicId,
      kind: asset.kind ?? 'image',
      mimeType: asset.mimeType ?? 'application/octet-stream',
      bytes: asset.byteSize ?? 0,
      width: asset.width,
      height: asset.height,
      durationSeconds: asset.durationSeconds,
      altText: asset.altText,
      downloadUrl: await signedMediaUrl(env, asset),
    });
  }

  // Resolved per publish rather than cached, because the whole point of storing platform
  // credentials in a table is that a rotated secret or a newly approved platform takes
  // effect without a deploy (plan §23). A cache would reintroduce the restart it removes.
  let app: ProviderAppCredentials | null = null;
  const strategy = stored[0]!.authStrategy;

  if (requiresProviderApp(strategy)) {
    const row = await findProviderApp(db, ownership.provider, ownership.projectId);

    if (!row || row.disabledAt || !row.clientId || !row.encryptedClientSecret) {
      // Blocked rather than thrown: a missing platform application is not this post's
      // fault and will not be fixed by retrying it. Blocking records a precise reason on
      // the target, which is what the dashboard shows and what a support reply quotes.
      return {
        blocked: {
          code: 'PROVIDER_NOT_CONFIGURED',
          message: `No application credentials are configured for ${ownership.provider}.`,
        },
      } as PublishContext;
    }

    const clientSecret = await cipher.decrypt(
      {
        ciphertext: row.encryptedClientSecret.ciphertext,
        nonce: row.encryptedClientSecret.nonce,
        algorithm: row.encryptedClientSecret.algorithm as typeof CREDENTIAL_ALGORITHM,
        keyVersion: row.encryptedClientSecret.keyVersion,
      },
      {
        // Matches how the API encrypted it: a platform-managed app belongs to no tenant,
        // so those slots carry a constant rather than being dropped from the AAD.
        organizationId: row.organizationId ?? 'platform',
        projectId: row.projectId ?? 'platform',
        connectionId: row.id,
        credentialType: 'client_secret',
      },
    );

    app = {
      clientId: row.clientId,
      clientSecret,
      redirectUri: `${env.PUBLIC_API_ORIGIN ?? ''}/v1/oauth/${ownership.provider}/callback`,
      metadata: (row.callbackConfig ?? {}) as Record<string, unknown>,
    };
  }

  return {
    credentials,
    app,
    destinationExternalId: ownership.providerDestinationId,
    content: {
      text: resolved.text ?? '',
      media,
      linkUrl: resolved.link ?? null,
      providerOptions: resolved.options,
      compliance: {},
    },
  };
}
