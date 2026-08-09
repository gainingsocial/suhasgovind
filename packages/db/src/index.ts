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
  markTargetPublished,
  markTargetReconciliationRequired,
  markTargetRetryableFailure,
  recalculatePostStatus,
  releaseTargetLease,
  listPosts,
  requeueFailedTargets,
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
  UpdateEndpointInput,
} from './repositories/webhooks.js';
export {
  createWebhookEndpoint,
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
