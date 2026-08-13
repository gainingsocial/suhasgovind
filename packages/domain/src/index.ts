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

export type {
  AgentPolicyRule,
  PolicyConditions,
  PolicyDecision,
  PolicyEffect,
  PolicyOutcome,
  ProposedAction,
} from './agents/policy.js';
export {
  DEFAULT_OUTCOME,
  SUGGESTED_POLICIES,
  evaluatePolicy,
  ruleMatches,
} from './agents/policy.js';

export type {
  FreshnessInput,
  FreshnessPlan,
  FreshnessTier,
  MetricValues,
  NormalizedMetric,
} from './analytics/freshness.js';
export {
  NORMALIZED_METRICS,
  deriveEngagements,
  engagementRate,
  metricDelta,
  planFreshness,
} from './analytics/freshness.js';

export type {
  ClaimKind,
  GroundedClaim,
  GroundingFailure,
  GroundingResult,
  SourceSpan,
} from './content/spans.js';
export {
  isPublishableAsGrounded,
  splitIntoSpans,
  verifyGrounding,
} from './content/spans.js';

export type {
  ModelErrorCode,
  ModelGateway,
  ModelRequest,
  ModelResponse,
} from './content/model-gateway.js';
export {
  ModelGatewayError,
  UNCONFIGURED_GATEWAY,
  extractionCacheKey,
} from './content/model-gateway.js';

export type { InjectionScan, ModelCallPolicy } from './content/untrusted-source.js';
export {
  EXTRACTION_POLICY,
  GENERATION_POLICY,
  fitToPolicy,
  htmlToText,
  scanForInjection,
  wrapUntrustedSource,
} from './content/untrusted-source.js';

export type { ConnectionHealth } from './connections/connection-health.js';
export {
  CONNECTION_HEALTH_STATES,
  canPublishWithHealth,
  healthAfterProviderError,
  isBlockingHealth,
} from './connections/connection-health.js';

export type {
  Confidence,
  PerformanceDimension,
  PerformanceMetric,
  PerformanceObservation,
  PostSample,
  Recommendation,
} from './memory/performance.js';
export {
  MIN_INTERESTING_LIFT,
  MIN_SAMPLE_SIZE,
  computeObservations,
  confidenceFor,
  recommendationsFrom,
  usefulRecommendations,
} from './memory/performance.js';

export type {
  ArticleDerivation,
  ArticleDerivationOptions,
  ArticleInput,
  DerivationSource,
} from './content/article.js';
export { deriveArticlePost, toHashtag } from './content/article.js';
