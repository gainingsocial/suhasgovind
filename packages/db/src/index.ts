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
