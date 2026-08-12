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
  ProviderOutcomeCounts,
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
  listPostAttempts,
  listPosts,
  requeueFailedTargets,
  requeueTarget,
  resolveReconciliation,
  startPublishAttempt,
  summarizeProviderOutcomes,
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
  ConnectionIdPlan,
  ConnectionWithScopes,
  DestinationOwnership,
  EncryptedCredentialInput,
  HealthTransition,
  ListConnectionsInput,
  SaveConnectionInput,
  SaveConnectionResult,
  SaveDestinationInput,
} from './repositories/connections.js';
export {
  countConnections,
  disconnectConnection,
  findConnectionById,
  findDestinationById,
  findDestinationOwnership,
  findDestinationOwnerships,
  listConnectionHealthEvents,
  listConnections,
  listDestinationsForConnection,
  planConnectionIds,
  saveConnection,
  selectConnectionDestinations,
  setConnectionHealth,
  storeDestinationCapabilities,
} from './repositories/connections.js';

export type {
  EnvironmentExecutionSettings,
  FlagBlock,
  FlagScope,
  ResolvedFlag,
  UpsertFlagInput,
} from './repositories/environment-settings.js';
export {
  evaluateFlag,
  findEnvironmentSettings,
  isFlagEnabled,
  providerBlockedBy,
  providerFlagKey,
  resolveFlags,
  setSimulationMode,
  upsertFeatureFlag,
} from './repositories/environment-settings.js';

export type {
  CreateApprovalInput,
  LoadPoliciesScope,
  RecordAgentActionInput,
  UpsertPolicyInput,
} from './repositories/agents.js';
export {
  createAgentIdentity,
  createAgentPolicy,
  createApprovalRequest,
  decideApproval,
  disableAgentPolicy,
  expireStaleApprovals,
  findAgentIdentity,
  findApprovalById,
  findPendingApproval,
  finishAgentRun,
  listAgentIdentities,
  listPendingApprovals,
  loadAgentPolicies,
  recordAgentAction,
  startAgentRun,
} from './repositories/agents.js';

export type {
  AnalyticsTotals,
  ListExternalPostsInput,
  RecordSnapshotInput,
  UpsertExternalPostInput,
} from './repositories/analytics.js';
export {
  findExternalPostById,
  findLatestSnapshot,
  findPostsDueForRefresh,
  listExternalPosts,
  listSnapshots,
  markExternalPostDeleted,
  recordAnalyticsSnapshot,
  summarizeProfileAnalytics,
  upsertExternalPost,
} from './repositories/analytics.js';

export type { RecordUsageInput, UsageMetric, UsageSummaryRow } from './repositories/usage.js';
export {
  USAGE_METRICS,
  incrementUsageCounter,
  listUsageEvents,
  meter,
  readUsageCounter,
  recordUsage,
  summarizeUsage,
  usageByDay,
  usageDate,
  usageMonth,
} from './repositories/usage.js';

export type {
  RecordProviderEventInput,
  RecordedProviderEvent,
} from './repositories/provider-events.js';
export {
  attachProviderEventOwner,
  findConnectionsByProviderAccount,
  findProviderEventById,
  findUnprocessedProviderEvents,
  markProviderEventProcessed,
  purgeProviderEvents,
  recordProviderEvent,
} from './repositories/provider-events.js';

export type { CreateOAuthSessionInput } from './repositories/oauth-sessions.js';
export {
  consumeOAuthSession,
  createOAuthSession,
  expireStaleOAuthSessions,
  failOAuthSession,
  findPendingOAuthSession,
} from './repositories/oauth-sessions.js';

export type {
  ConnectSessionWithProfile,
  CreateConnectSessionInput,
} from './repositories/connect-sessions.js';
export {
  completeConnectSession,
  createConnectSession,
  findConnectSessionById,
} from './repositories/connect-sessions.js';

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

export type {
  ConnectionDueForRefresh,
  ExpiringCredential,
  StoreCredentialInput,
  StoredCredential,
} from './repositories/credentials.js';
export {
  acquireRefreshLock,
  findConnectionCredentials,
  findConnectionsDueForRefresh,
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
  findProviderAppById,
  listProviderApps,
  loadProviderAppWithCredentials,
  setApprovalStatus,
  upsertProviderApp,
} from './repositories/provider-apps.js';
