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

export type {
  TextAdaptation,
  TextAdaptationKind,
  TextFitInput,
  TextFitResult,
} from './posts/text-fit.js';
export {
  extractHashtags,
  graphemeLength,
  planTextFit,
  stripTrailingHashtags,
  truncateAtBoundary,
} from './posts/text-fit.js';

export type { AspectRatio } from './media/aspect-ratio.js';
export {
  ASPECT_RATIO_TOLERANCE,
  centredCrop,
  cropLoss,
  nearestRatio,
  parseAspectRatio,
  ratioMatches,
} from './media/aspect-ratio.js';

export type {
  FitDecision,
  MediaFitInput,
  MediaFitPlan,
  PlannedTransform,
  PostMediaFitPlan,
  TransformKind,
} from './media/fit-plan.js';
export {
  SAFE_CROP_LOSS,
  planMediaFit,
  planPostMediaFit,
  variantKeyFor,
  worstDecision,
} from './media/fit-plan.js';

export type { ConnectionHealth } from './connections/connection-health.js';
export {
  CONNECTION_HEALTH_STATES,
  canPublishWithHealth,
  healthAfterProviderError,
  isBlockingHealth,
} from './connections/connection-health.js';
