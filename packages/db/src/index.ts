export type {
  CreateDatabaseOptions,
  Database,
  DatabaseHandle,
  HyperdriveBinding,
  Sql,
  Transaction,
} from './client.js';
export { createDatabaseFromEnv, createDatabaseHandle, schema } from './client.js';

export * from './schema/index.js';

export {
  createApiKeyRepository,
  findApiKeyByHash,
  touchApiKeyLastUsed,
} from './repositories/api-keys.js';

export type {
  CompleteReservationInput,
  ReservationOutcome,
  ReserveIdempotencyInput,
} from './repositories/idempotency.js';
export {
  completeReservation,
  failReservation,
  purgeExpiredIdempotencyKeys,
  reserveIdempotency,
} from './repositories/idempotency.js';

export type {
  CreatePostWithTargetsInput,
  CreateTargetInput,
  CreatedPost,
  FinishAttemptInput,
  LeaseResult,
  LeaseTargetInput,
  RecalculateResult,
  ListPostsInput,
  PostListRow,
  RecordAttemptInput,
} from './repositories/posts.js';
export {
  cancelPostTargets,
  createPostWithTargets,
  enqueueTargets,
  findAbandonedTargets,
  findOverdueScheduledPosts,
  finishPublishAttempt,
  getPostWithTargets,
  leaseTargetForExecution,
  markTargetPermanentFailure,
  markTargetProviderProcessing,
  recordPreparedProviderIds,
  markTargetPublished,
  markTargetReconciliationRequired,
  markTargetRetryableFailure,
  recalculatePostStatus,
  releaseTargetLease,
  listPosts,
  requeueFailedTargets,
  resolveReconciliation,
  startPublishAttempt,
} from './repositories/posts.js';

export type {
  CreateProfileInput,
  ListProfilesInput,
  ProfileScope,
  UpdateProfileInput,
} from './repositories/profiles.js';
export {
  countProfiles,
  createProfile,
  findProfileById,
  findProfileOwnership,
  listProfiles,
  softDeleteProfile,
  updateProfile,
} from './repositories/profiles.js';

export type {
  ConnectionWithScopes,
  DestinationOwnership,
  ListConnectionsInput,
} from './repositories/connections.js';
export {
  countConnections,
  disconnectConnection,
  findConnectionById,
  findDestinationById,
  findDestinationOwnership,
  findDestinationOwnerships,
  listConnections,
  listDestinationsForConnection,
  setConnectionHealth,
  storeDestinationCapabilities,
} from './repositories/connections.js';

export type { CreateUploadIntentInput, ProbeResult } from './repositories/media.js';
export {
  createExternalMedia,
  createUploadIntent,
  expireAbandonedUploads,
  findMediaById,
  findMediaByIds,
  findMediaOwnership,
  markProbeFailed,
  markProbed,
  markUploaded,
  softDeleteMedia,
} from './repositories/media.js';

export type {
  CreateEndpointInput,
  DeliveryWithEvent,
  EmitEventInput,
  EndpointWithSubscriptions,
  LeasedDelivery,
  RecordDeliveryResultInput,
  UpdateEndpointInput,
} from './repositories/webhooks.js';
export {
  createWebhookEndpoint,
  leaseWebhookDelivery,
  recordDeliveryResult,
  deleteWebhookEndpoint,
  emitWebhookEvent,
  findDueDeliveries,
  findWebhookDeliveryById,
  findWebhookEndpointById,
  listWebhookDeliveries,
  listWebhookEndpoints,
  replayWebhookDelivery,
  rotateWebhookSecret,
  updateWebhookEndpoint,
} from './repositories/webhooks.js';

export type { StoreCredentialInput, StoredCredential } from './repositories/credentials.js';
export {
  acquireRefreshLock,
  findConnectionCredentials,
  findCredentialsNearingExpiry,
  releaseRefreshLock,
  storeCredential,
} from './repositories/credentials.js';

export type { ApiKeySummary, CreateApiKeyInput, MembershipContext } from './repositories/api-key-admin.js';
export {
  createApiKey,
  findMembershipForEnvironment,
  listApiKeys,
  listEnvironmentsForUser,
  revokeApiKey,
} from './repositories/api-key-admin.js';

export type {
  ProviderAppCredentialFields,
  UpsertProviderAppInput,
} from './repositories/provider-apps.js';
export {
  deleteProviderApp,
  findProviderApp,
  listProviderApps,
  setApprovalStatus,
  upsertProviderApp,
} from './repositories/provider-apps.js';
