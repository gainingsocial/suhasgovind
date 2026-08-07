export type { PostStatus, PostTargetStatus } from './posts/post-state-machine.js';
export {
  ACTIVE_TARGET_STATUSES,
  InvalidTargetTransitionError,
  LEASABLE_TARGET_STATUSES,
  POST_STATUSES,
  POST_TARGET_STATUSES,
  TERMINAL_TARGET_STATUSES,
  assertTargetTransition,
  canCancelPost,
  canTransitionTarget,
  isRetryableTargetStatus,
  isTerminalPostStatus,
  isTerminalTargetStatus,
  reducePostStatus,
  selectTargetsForRetry,
} from './posts/post-state-machine.js';

export type {
  FingerprintInput,
  PostContent,
  ProviderOptionsMap,
  ResolveContentInput,
  ResolvedTargetContent,
  TargetOverrides,
} from './posts/content-resolution.js';
export {
  buildFingerprintInput,
  canonicalizeForHashing,
  resolveTargetContent,
} from './posts/content-resolution.js';

export type { ConnectionHealth } from './connections/connection-health.js';
export {
  CONNECTION_HEALTH_STATES,
  canPublishWithHealth,
  healthAfterProviderError,
  isBlockingHealth,
} from './connections/connection-health.js';
