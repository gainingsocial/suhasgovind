import type { ErrorCode } from './codes.js';
import { ERROR_CODES } from './codes.js';
import type { ErrorType } from './types.js';

/**
 * Every public error code declares its HTTP status, family, retryability and the
 * canonical machine action an agent should take (plan §16, §79).
 *
 * `retryable` here is the *default* for the code. A specific occurrence may override it —
 * for example a provider 5xx that the adapter knows is permanent for this content.
 */
export interface ErrorCodeMetadata {
  type: ErrorType;
  status: number;
  /** Default retryability. Explicit on every code — never inferred from status. */
  retryable: boolean;
  /** Canonical machine-executable next step, `snake_case`. */
  agentAction?: string;
  /** Default human-readable message. Call sites usually supply a more specific one. */
  message: string;
}

const m = (
  type: ErrorType,
  status: number,
  retryable: boolean,
  message: string,
  agentAction?: string,
): ErrorCodeMetadata => ({ type, status, retryable, message, ...(agentAction ? { agentAction } : {}) });

export const ERROR_CODE_METADATA: Record<ErrorCode, ErrorCodeMetadata> = {
  // ---- authentication / authorization ---------------------------------------
  AUTHENTICATION_REQUIRED: m(
    'authentication_error',
    401,
    false,
    'An API key is required. Send it as `Authorization: Bearer sk_live_...`.',
    'supply_api_key',
  ),
  API_KEY_INVALID: m('authentication_error', 401, false, 'The API key is not valid.', 'supply_valid_api_key'),
  API_KEY_REVOKED: m('authentication_error', 401, false, 'This API key has been revoked.', 'create_new_api_key'),
  API_KEY_EXPIRED: m('authentication_error', 401, false, 'This API key has expired.', 'create_new_api_key'),
  API_KEY_MALFORMED: m(
    'authentication_error',
    401,
    false,
    'The API key is malformed. Expected a key beginning with `sk_test_` or `sk_live_`.',
    'supply_valid_api_key',
  ),
  INSUFFICIENT_SCOPE: m(
    'authorization_error',
    403,
    false,
    'This API key does not have the scope required for this operation.',
    'request_key_with_required_scope',
  ),
  ENVIRONMENT_MISMATCH: m(
    'authorization_error',
    403,
    false,
    'The resource belongs to a different environment than this API key.',
    'use_matching_environment_key',
  ),
  // "not usable by this request", not "not yours" — a resource genuinely belonging to
  // somebody else never reaches this code, it returns the same NOT_FOUND an id that never
  // existed would. See docs/errors/README.md, "Where the line sits".
  TENANT_FORBIDDEN: m(
    'authorization_error',
    403,
    false,
    'This request may not use that resource.',
    'use_a_resource_this_request_may_address',
  ),

  // ---- request shape --------------------------------------------------------
  INVALID_REQUEST: m('validation_error', 400, false, 'The request body failed validation.', 'fix_request_body'),
  MISSING_REQUIRED_FIELD: m('validation_error', 400, false, 'A required field is missing.', 'supply_required_field'),
  UNSUPPORTED_CONTENT_TYPE: m(
    'validation_error',
    415,
    false,
    'Send `Content-Type: application/json`.',
    'use_json_content_type',
  ),
  REQUEST_TOO_LARGE: m(
    'validation_error',
    413,
    false,
    'The request body is too large. Upload media through the media endpoints instead of inline.',
    'upload_media_via_media_endpoint',
  ),
  UNSUPPORTED_API_VERSION: m(
    'validation_error',
    400,
    false,
    'The requested API version is not supported.',
    'use_supported_api_version',
  ),

  // ---- resources ------------------------------------------------------------
  PROFILE_NOT_FOUND: m('not_found_error', 404, false, 'No such profile.', 'list_profiles'),
  CONNECTION_NOT_FOUND: m('not_found_error', 404, false, 'No such connection.', 'list_connections'),
  DESTINATION_NOT_FOUND: m('not_found_error', 404, false, 'No such destination.', 'list_destinations'),
  MEDIA_NOT_FOUND: m('not_found_error', 404, false, 'No such media asset.', 'upload_media'),
  POST_NOT_FOUND: m('not_found_error', 404, false, 'No such post.', 'list_posts'),
  TARGET_NOT_FOUND: m('not_found_error', 404, false, 'No such publish target.', 'get_post'),
  WEBHOOK_NOT_FOUND: m('not_found_error', 404, false, 'No such webhook endpoint.', 'list_webhooks'),
  DELIVERY_NOT_FOUND: m('not_found_error', 404, false, 'No such webhook delivery.', 'list_webhook_deliveries'),
  RESOURCE_NOT_FOUND: m('not_found_error', 404, false, 'The requested resource does not exist.'),

  // ---- idempotency & conflict ----------------------------------------------
  IDEMPOTENCY_KEY_REUSED: m(
    'idempotency_error',
    409,
    false,
    'This Idempotency-Key was already used with a different request body.',
    'use_a_new_idempotency_key',
  ),
  IDEMPOTENCY_REQUEST_IN_PROGRESS: m(
    'idempotency_error',
    409,
    true,
    'A request with this Idempotency-Key is still being processed. Retry shortly.',
    'retry_after_delay',
  ),
  DUPLICATE_CONTENT_BLOCKED: m(
    'conflict_error',
    409,
    false,
    'Equivalent content was recently published to this destination. Set `allow_duplicate: true` to override.',
    'set_allow_duplicate_or_change_content',
  ),
  POST_NOT_CANCELLABLE: m(
    'conflict_error',
    409,
    false,
    'This post can no longer be cancelled because publishing has begun or completed.',
    'inspect_post_status',
  ),
  POST_NOT_RETRYABLE: m(
    'conflict_error',
    409,
    false,
    'This post has no targets in a retryable state.',
    'inspect_post_targets',
  ),
  TARGET_NOT_RETRYABLE: m(
    'conflict_error',
    409,
    false,
    'This target is not in a retryable state.',
    'inspect_target_status',
  ),
  CONFLICTING_STATE: m('conflict_error', 409, false, 'The resource changed while this request was in flight.', 'reload_and_retry'),
  IDEMPOTENCY_KEY_REQUIRED: m(
    'idempotency_error',
    400,
    false,
    'An Idempotency-Key header is required for this operation.',
    'retry_with_an_idempotency_key',
  ),
  VALIDATION_FAILED: m(
    'validation_error',
    422,
    false,
    'One or more publish targets cannot accept this content as composed.',
    'run_preflight_and_fix_reported_issues',
  ),
  RESOURCE_ALREADY_EXISTS: m(
    'conflict_error',
    409,
    false,
    'A resource with that identifier already exists.',
    'fetch_the_existing_resource_or_choose_another_identifier',
  ),

  // ---- connection health ----------------------------------------------------
  CONNECTION_REAUTH_REQUIRED: m(
    'connection_error',
    409,
    false,
    'The social connection must be re-authorized before it can publish.',
    'create_connect_session_for_reauthorization',
  ),
  CONNECTION_DISCONNECTED: m(
    'connection_error',
    409,
    false,
    'The social connection is disconnected.',
    'create_connect_session_for_reauthorization',
  ),
  CONNECTION_REVOKED: m(
    'connection_error',
    409,
    false,
    'Access was revoked at the provider.',
    'create_connect_session_for_reauthorization',
  ),
  CONNECTION_PERMISSION_MISSING: m(
    'connection_error',
    409,
    false,
    'The connection is missing a permission required for this operation.',
    'reauthorize_with_required_scopes',
  ),
  CONNECTION_INCOMPLETE_SETUP: m(
    'connection_error',
    409,
    false,
    'This connection requires a destination selection before it can publish.',
    'select_destination_for_connection',
  ),
  CONNECTION_RATE_LIMITED: m(
    'rate_limit_error',
    429,
    true,
    'This social account is currently rate limited by the provider.',
    'retry_after_delay',
  ),

  // ---- connecting an account ------------------------------------------------
  PROVIDER_NOT_CONFIGURED: m(
    'connection_error',
    // 503 rather than 400: nothing about the request was wrong, and the condition is
    // expected to clear once the platform application is configured.
    503,
    true,
    'This platform is not yet available for connecting. Its application credentials are not configured.',
    'check_platform_availability',
  ),
  PROVIDER_TEMPORARILY_DISABLED: m(
    'connection_error',
    // 503 and retryable: the request was correct and will work once the switch is flipped
    // back. A 4xx would send an integrator hunting for a fault in their own payload.
    503,
    true,
    'Publishing to this platform is temporarily switched off.',
    'retry_later_or_publish_to_another_destination',
  ),
  APPROVAL_ALREADY_DECIDED: m(
    'conflict_error',
    409,
    false,
    'This approval request has already been decided.',
    'read_the_current_decision',
  ),
  AUTHORIZATION_SESSION_INVALID: m(
    'connection_error',
    400,
    false,
    'This authorization link is invalid, already used, or expired.',
    'start_authorization_again',
  ),
  AUTHORIZATION_FAILED: m(
    'connection_error',
    400,
    false,
    'The provider did not complete the authorization.',
    'start_authorization_again',
  ),
  AUTHORIZATION_CREDENTIAL_REJECTED: m(
    'connection_error',
    400,
    false,
    'The provider rejected the supplied credential.',
    'check_credential_and_try_again',
  ),
  REDIRECT_URL_NOT_ALLOWED: m(
    'validation_error',
    400,
    false,
    'That redirect URL is not permitted. It must be absolute HTTPS.',
    'use_an_allowed_https_redirect_url',
  ),
  CONNECT_SESSION_INVALID: m(
    'connection_error',
    400,
    false,
    'This connect session is expired, already completed, or unknown.',
    'create_connect_session',
  ),

  // ---- capability / preflight ----------------------------------------------
  CAPABILITY_NOT_SUPPORTED: m(
    'validation_error',
    422,
    false,
    'The destination does not support this capability.',
    'check_destination_capabilities',
  ),
  POST_TYPE_NOT_SUPPORTED: m(
    'validation_error',
    422,
    false,
    'The destination does not support this post type.',
    'choose_supported_post_type',
  ),
  TEXT_TOO_LONG: m('validation_error', 422, false, 'The text exceeds the destination limit.', 'shorten_text'),
  TEXT_REQUIRED: m('validation_error', 422, false, 'This destination requires text content.', 'supply_text'),
  MEDIA_REQUIRED: m('validation_error', 422, false, 'This destination requires at least one media item.', 'attach_media'),
  MEDIA_COUNT_EXCEEDED: m(
    'validation_error',
    422,
    false,
    'Too many media items for this destination.',
    'reduce_media_count',
  ),
  MEDIA_TYPE_UNSUPPORTED: m(
    'media_error',
    422,
    false,
    'The media type is not supported by this destination.',
    'create_media_variant',
  ),
  MEDIA_RATIO_UNSUPPORTED: m(
    'media_error',
    422,
    false,
    'The media aspect ratio is not valid for this destination.',
    'create_or_select_a_compliant_media_variant',
  ),
  MEDIA_TOO_LARGE: m('media_error', 422, false, 'The media file exceeds the destination size limit.', 'create_media_variant'),
  MEDIA_DURATION_UNSUPPORTED: m(
    'media_error',
    422,
    false,
    'The video duration is outside the range this destination accepts.',
    'trim_video_duration',
  ),
  MEDIA_RESOLUTION_UNSUPPORTED: m(
    'media_error',
    422,
    false,
    'The media resolution is not valid for this destination.',
    'create_media_variant',
  ),
  MEDIA_NOT_READY: m(
    'media_error',
    409,
    true,
    'The media asset is still being processed.',
    'wait_for_media_ready_webhook',
  ),
  MEDIA_MIXED_TYPES_UNSUPPORTED: m(
    'media_error',
    422,
    false,
    'This destination cannot mix images and video in one post.',
    'split_into_separate_posts',
  ),
  LINK_NOT_SUPPORTED: m('validation_error', 422, false, 'This destination does not support link attachments.', 'remove_link'),
  PROVIDER_OPTION_INVALID: m(
    'validation_error',
    422,
    false,
    'A provider-specific option is invalid.',
    'fix_provider_option',
  ),
  PROVIDER_OPTION_REQUIRED: m(
    'validation_error',
    422,
    false,
    'A provider-specific option is required for this destination.',
    'supply_required_provider_option',
  ),
  PRIVACY_SELECTION_REQUIRED: m(
    'validation_error',
    422,
    false,
    'This destination requires an explicit privacy level.',
    'choose_allowed_privacy_level',
  ),
  COMPLIANCE_DECLARATION_REQUIRED: m(
    'validation_error',
    422,
    false,
    'This destination requires a compliance declaration before publishing.',
    'supply_required_compliance_declaration',
  ),
  SCHEDULE_IN_PAST: m('validation_error', 422, false, '`publish_at` must be in the future.', 'choose_future_publish_at'),
  SCHEDULE_TOO_FAR_AHEAD: m(
    'validation_error',
    422,
    false,
    '`publish_at` is beyond the maximum scheduling horizon.',
    'choose_nearer_publish_at',
  ),
  SCHEDULE_NOT_SUPPORTED: m(
    'validation_error',
    422,
    false,
    'This destination does not support scheduled publishing.',
    'publish_immediately',
  ),
  TARGETS_REQUIRED: m('validation_error', 422, false, 'At least one target is required.', 'add_target'),
  DUPLICATE_DESTINATION: m(
    'validation_error',
    422,
    false,
    'The same destination appears more than once in `targets`.',
    'deduplicate_targets',
  ),

  // ---- rate limiting --------------------------------------------------------
  RATE_LIMITED: m('rate_limit_error', 429, true, 'Too many requests. Slow down.', 'retry_after_delay'),
  QUOTA_EXCEEDED: m(
    'rate_limit_error',
    429,
    true,
    'A provider quota for this account is exhausted.',
    'retry_after_quota_reset',
  ),
  PLAN_LIMIT_REACHED: m(
    'rate_limit_error',
    402,
    false,
    'Your plan limit has been reached.',
    'upgrade_plan_or_wait_for_period_reset',
  ),

  // ---- provider-side --------------------------------------------------------
  PROVIDER_NOT_SUPPORTED: m(
    'validation_error',
    400,
    false,
    'This provider is not supported.',
    'check_supported_providers',
  ),
  PROVIDER_UNAVAILABLE: m(
    'provider_error',
    503,
    true,
    'The social provider is temporarily unavailable.',
    'retry_after_delay',
  ),
  PROVIDER_TIMEOUT: m('provider_error', 504, true, 'The social provider did not respond in time.', 'retry_after_delay'),
  PROVIDER_REJECTED_CONTENT: m(
    'provider_error',
    422,
    false,
    'The provider rejected this content.',
    'revise_content',
  ),
  PROVIDER_CONFLICT: m('provider_error', 409, false, 'The provider reported a conflicting state.', 'inspect_target_status'),
  PROVIDER_ACCOUNT_NOT_ELIGIBLE: m(
    'provider_error',
    422,
    false,
    'The connected account is not eligible for this operation.',
    'check_destination_capabilities',
  ),
  POSSIBLE_DUPLICATE: m(
    'provider_error',
    409,
    false,
    'The provider indicates equivalent content may already exist.',
    'inspect_destination_before_retrying',
  ),
  RECONCILIATION_REQUIRED: m(
    'provider_error',
    409,
    false,
    'The outcome of the previous publish attempt is unknown and is being reconciled. Do not retry blindly.',
    'wait_for_reconciliation',
  ),
  UNKNOWN_PROVIDER_ERROR: m(
    'provider_error',
    502,
    false,
    'The provider returned an error we could not classify.',
    'inspect_post_timeline',
  ),

  // ---- media pipeline -------------------------------------------------------
  MEDIA_UPLOAD_INCOMPLETE: m(
    'media_error',
    409,
    false,
    'The upload was never completed. Call the upload completion endpoint.',
    'complete_media_upload',
  ),
  MEDIA_PROBE_FAILED: m(
    'media_error',
    422,
    false,
    'The media file could not be read. It may be corrupt or an unsupported container.',
    'upload_a_different_file',
  ),
  MEDIA_PROCESSING_FAILED: m('media_error', 422, false, 'Media processing failed.', 'upload_a_different_file'),
  MEDIA_URL_NOT_ALLOWED: m(
    'media_error',
    422,
    false,
    'The media URL is not allowed. It must be a public HTTPS URL that does not resolve to a private network.',
    'use_public_https_url_or_upload_media',
  ),

  // ---- content intelligence (plan §63Q, §63R) -------------------------------
  MODEL_PROVIDER_NOT_CONFIGURED: m(
    'api_error',
    503,
    false,
    'No model provider is configured. Content Intelligence needs one; publishing does not.',
    'contact_support',
  ),
  CONTENT_GROUNDING_FAILED: m(
    'validation_error',
    422,
    false,
    'A generated claim could not be traced to the source it cites.',
    'edit_ungrounded_claims',
  ),
  SOURCE_NOT_FOUND: m('not_found_error', 404, false, 'No such content source.'),
  DRAFT_SET_NOT_FOUND: m('not_found_error', 404, false, 'No such draft set.'),

  // ---- internal -------------------------------------------------------------
  INTERNAL_ERROR: m('api_error', 500, true, 'An unexpected error occurred.', 'retry_after_delay'),
  NOT_IMPLEMENTED: m('api_error', 501, false, 'This operation is not implemented yet.'),
  FEATURE_DISABLED: m('api_error', 403, false, 'This feature is not enabled for your project.', 'contact_support'),
  SIMULATION_ONLY: m(
    'api_error',
    403,
    false,
    'This operation is only available in simulation mode.',
    'use_live_environment',
  ),
};

/** Fail fast at module load if a code was added without metadata. */
for (const code of ERROR_CODES) {
  if (!ERROR_CODE_METADATA[code]) {
    throw new Error(`Missing ERROR_CODE_METADATA entry for error code "${code}"`);
  }
}
