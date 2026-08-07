CREATE TYPE "public"."actor_type" AS ENUM('user', 'api_key', 'system', 'agent');--> statement-breakpoint
CREATE TYPE "public"."api_key_status" AS ENUM('active', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."attempt_outcome" AS ENUM('published', 'provider_processing', 'retryable_failed', 'permanent_failed', 'unknown_reconciliation_required', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."auth_strategy" AS ENUM('oauth2', 'oauth2_pkce', 'oauth1', 'manual_token', 'bot_token', 'webhook_url', 'api_key', 'app_password', 'custom');--> statement-breakpoint
CREATE TYPE "public"."connection_health" AS ENUM('healthy', 'refresh_due', 'refreshing', 'reauth_required', 'permission_missing', 'rate_limited', 'provider_degraded', 'disconnected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."credential_type" AS ENUM('access_token', 'refresh_token', 'app_password', 'bot_token', 'api_key', 'webhook_url', 'oauth1_token', 'oauth1_token_secret', 'client_secret');--> statement-breakpoint
CREATE TYPE "public"."environment_kind" AS ENUM('test', 'live');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video', 'audio', 'document');--> statement-breakpoint
CREATE TYPE "public"."media_source" AS ENUM('upload', 'external_url', 'derived');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('awaiting_upload', 'uploaded', 'probing', 'ready', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."oauth_session_status" AS ENUM('pending', 'consumed', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."organization_role" AS ENUM('owner', 'admin', 'developer', 'marketer', 'analyst', 'billing', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'validating', 'awaiting_approval', 'scheduled', 'queued', 'publishing', 'published', 'partially_published', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."post_target_status" AS ENUM('pending', 'blocked_validation', 'awaiting_approval', 'scheduled', 'queued', 'preparing_media', 'publishing', 'provider_processing', 'published', 'retryable_failed', 'permanent_failed', 'cancelled', 'unknown_reconciliation_required');--> statement-breakpoint
CREATE TYPE "public"."provider_app_ownership" AS ENUM('platform_managed', 'customer_managed');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivering', 'succeeded', 'failed_retryable', 'exhausted');--> statement-breakpoint
CREATE TYPE "public"."webhook_endpoint_status" AS ENUM('enabled', 'disabled', 'auto_disabled');--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "organization_role" DEFAULT 'viewer' NOT NULL,
	"invited_by" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"disabled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "environment_kind" NOT NULL,
	"simulation_mode" boolean DEFAULT false NOT NULL,
	"allow_test_key_live_connections" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key_scopes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"api_key_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"status" "api_key_status" DEFAULT 'active' NOT NULL,
	"restricted_to_profile_id" uuid,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connect_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"providers" text[] NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"return_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by_api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_health_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"from_health" "connection_health",
	"to_health" "connection_health" NOT NULL,
	"reason" text,
	"provider_error_code" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_scopes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"granted" boolean DEFAULT true NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"provider_app_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state" text NOT NULL,
	"encrypted_code_verifier" jsonb,
	"redirect_uri" text NOT NULL,
	"return_url" text,
	"requested_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"connect_session_id" uuid,
	"reconnect_connection_id" uuid,
	"status" "oauth_session_status" DEFAULT 'pending' NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_apps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"organization_id" uuid,
	"provider" text NOT NULL,
	"ownership" "provider_app_ownership" DEFAULT 'platform_managed' NOT NULL,
	"client_id" text,
	"encrypted_client_secret" jsonb,
	"callback_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approval_status" text DEFAULT 'not_submitted' NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"disabled_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_app_id" uuid,
	"provider" text NOT NULL,
	"auth_strategy" "auth_strategy" NOT NULL,
	"provider_account_id" text NOT NULL,
	"provider_account_name" text,
	"provider_account_handle" text,
	"provider_account_avatar_url" text,
	"health" "connection_health" DEFAULT 'healthy' NOT NULL,
	"health_detail" text,
	"health_checked_at" timestamp with time zone,
	"setup_completed_at" timestamp with time zone,
	"refresh_locked_until" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"credential_type" "credential_type" NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"algorithm" text DEFAULT 'AES-256-GCM' NOT NULL,
	"key_version" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"refresh_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_destinations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_destination_id" text NOT NULL,
	"destination_type" text NOT NULL,
	"name" text NOT NULL,
	"handle" text,
	"avatar_url" text,
	"url" text,
	"selected" boolean DEFAULT true NOT NULL,
	"capabilities" jsonb,
	"capabilities_refreshed_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" "media_status" DEFAULT 'awaiting_upload' NOT NULL,
	"source" "media_source" DEFAULT 'upload' NOT NULL,
	"kind" "media_kind",
	"storage_key" text,
	"external_url" text,
	"filename" text,
	"mime_type" text,
	"byte_size" bigint,
	"width" integer,
	"height" integer,
	"duration_seconds" real,
	"aspect_ratio" real,
	"frame_rate" real,
	"video_codec" text,
	"audio_codec" text,
	"has_audio" boolean,
	"content_hash" text,
	"alt_text" text,
	"probe_error" text,
	"probed_at" timestamp with time zone,
	"upload_expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"transform_signature" text NOT NULL,
	"transform_spec_version" text NOT NULL,
	"transform_parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" text,
	"purpose" text,
	"status" "media_status" DEFAULT 'probing' NOT NULL,
	"storage_key" text,
	"mime_type" text,
	"byte_size" bigint,
	"width" integer,
	"height" integer,
	"duration_seconds" real,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"expires_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_target_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_target_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"outcome" "attempt_outcome",
	"provider_post_id" text,
	"error_code" text,
	"error_message" text,
	"provider_error_subcode" text,
	"provider_status" integer,
	"lease_id" uuid,
	"request_summary" jsonb,
	"response_summary" jsonb,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" "post_target_status" DEFAULT 'pending' NOT NULL,
	"overrides" jsonb,
	"options" jsonb,
	"resolved_content" jsonb,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"provider_post_id" text,
	"provider_post_url" text,
	"published_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"provider_error_subcode" text,
	"retryable" boolean,
	"content_fingerprint" text,
	"reconciliation_required_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" "post_status" DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"publish_at" timestamp with time zone,
	"timezone" text,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"allow_duplicate" boolean DEFAULT false NOT NULL,
	"workflow_instance_id" text,
	"idempotency_key_id" uuid,
	"created_by_api_key_id" uuid,
	"created_by_user_id" uuid,
	"request_id" text,
	"trace_id" text,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'in_progress' NOT NULL,
	"resource_type" text,
	"resource_id" uuid,
	"response_snapshot" jsonb,
	"response_status" text,
	"api_key_id" uuid,
	"request_id" text,
	"trace_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbound_webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid,
	"event_type" text NOT NULL,
	"api_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"aggregate_type" text,
	"aggregate_id" uuid,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"webhook_endpoint_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_status_code" integer,
	"last_duration_ms" integer,
	"last_error" text,
	"last_response_excerpt" text,
	"delivered_at" timestamp with time zone,
	"exhausted_at" timestamp with time zone,
	"replay_of_delivery_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"status" "webhook_endpoint_status" DEFAULT 'enabled' NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"secret_rotated_at" timestamp with time zone,
	"profile_id" uuid,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"auto_disabled_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"api_version" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"webhook_endpoint_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"description" text,
	"organization_id" uuid,
	"project_id" uuid,
	"project_environment_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"rollout_percentage" real,
	"value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"schema_version" text DEFAULT '1' NOT NULL,
	"adapter_version" text NOT NULL,
	"features" jsonb NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_compliance_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"rule_key" text NOT NULL,
	"rule_type" text NOT NULL,
	"applies_to" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"definition" jsonb NOT NULL,
	"severity" text DEFAULT 'blocking' NOT NULL,
	"docs_url" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_health_status" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'operational' NOT NULL,
	"error_rate" real,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_incident_at" timestamp with time zone,
	"detail" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"api_version" text NOT NULL,
	"adapter_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"deprecated_at" timestamp with time zone,
	"sunset_at" timestamp with time zone,
	"notes" text,
	"docs_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_request_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"project_environment_id" uuid,
	"organization_id" uuid,
	"api_key_id" uuid,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"route_pattern" text,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_code" text,
	"idempotency_key" text,
	"request_summary" jsonb,
	"response_summary" jsonb,
	"user_agent" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"project_environment_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"changes" jsonb,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"trace_id" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text,
	"fingerprint" text,
	"event_type" text,
	"connection_id" uuid,
	"project_environment_id" uuid,
	"signature_verified" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"trace_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_request_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_environment_id" uuid,
	"organization_id" uuid,
	"provider" text NOT NULL,
	"connection_id" uuid,
	"destination_id" uuid,
	"operation" text NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"status" integer,
	"duration_ms" integer,
	"outcome" text NOT NULL,
	"normalized_error_code" text,
	"request_summary" jsonb,
	"response_summary" jsonb,
	"rate_limit" jsonb,
	"request_id" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_environment_id" uuid,
	"metric" text NOT NULL,
	"period" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_environment_id" uuid NOT NULL,
	"profile_id" uuid,
	"metric" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"provider" text,
	"resource_type" text,
	"resource_id" uuid,
	"usage_date" text NOT NULL,
	"trace_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_scopes" ADD CONSTRAINT "api_key_scopes_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_restricted_to_profile_id_profiles_id_fk" FOREIGN KEY ("restricted_to_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_sessions" ADD CONSTRAINT "connect_sessions_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connect_sessions" ADD CONSTRAINT "connect_sessions_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_health_events" ADD CONSTRAINT "connection_health_events_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_scopes" ADD CONSTRAINT "connection_scopes_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_sessions" ADD CONSTRAINT "oauth_sessions_provider_app_id_provider_apps_id_fk" FOREIGN KEY ("provider_app_id") REFERENCES "public"."provider_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_apps" ADD CONSTRAINT "provider_apps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_apps" ADD CONSTRAINT "provider_apps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_provider_app_id_provider_apps_id_fk" FOREIGN KEY ("provider_app_id") REFERENCES "public"."provider_apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_credentials" ADD CONSTRAINT "social_credentials_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_credentials" ADD CONSTRAINT "social_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_credentials" ADD CONSTRAINT "social_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_destinations" ADD CONSTRAINT "social_destinations_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_destinations" ADD CONSTRAINT "social_destinations_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_destinations" ADD CONSTRAINT "social_destinations_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_destinations" ADD CONSTRAINT "social_destinations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_variants" ADD CONSTRAINT "media_variants_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_variants" ADD CONSTRAINT "media_variants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_approvals" ADD CONSTRAINT "post_approvals_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_approvals" ADD CONSTRAINT "post_approvals_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_target_attempts" ADD CONSTRAINT "post_target_attempts_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_target_attempts" ADD CONSTRAINT "post_target_attempts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_destination_id_social_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."social_destinations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_webhook_events" ADD CONSTRAINT "outbound_webhook_events_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_webhook_events" ADD CONSTRAINT "outbound_webhook_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_webhook_events" ADD CONSTRAINT "outbound_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_webhook_events" ADD CONSTRAINT "outbound_webhook_events_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_outbound_webhook_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outbound_webhook_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_webhook_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_request_logs" ADD CONSTRAINT "provider_request_logs_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_request_logs" ADD CONSTRAINT "provider_request_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_members_org_user_key" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "profiles_environment_created_idx" ON "profiles" USING btree ("project_environment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_environment_external_id_key" ON "profiles" USING btree ("project_environment_id","external_id") WHERE "profiles"."external_id" IS NOT NULL AND "profiles"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_environments_project_kind_key" ON "project_environments" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "project_environments_org_idx" ON "project_environments" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_slug_key" ON "projects" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_scopes_key_scope_key" ON "api_key_scopes" USING btree ("api_key_id","scope");--> statement-breakpoint
CREATE INDEX "api_key_scopes_key_idx" ON "api_key_scopes" USING btree ("api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_environment_idx" ON "api_keys" USING btree ("project_environment_id");--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "connect_sessions_profile_idx" ON "connect_sessions" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "connect_sessions_expiry_idx" ON "connect_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "connection_health_events_connection_created_idx" ON "connection_health_events" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_scopes_connection_scope_key" ON "connection_scopes" USING btree ("connection_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_sessions_state_key" ON "oauth_sessions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "oauth_sessions_profile_idx" ON "oauth_sessions" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "oauth_sessions_expiry_idx" ON "oauth_sessions" USING btree ("expires_at") WHERE "oauth_sessions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "provider_apps_provider_idx" ON "provider_apps" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "provider_apps_project_idx" ON "provider_apps" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_apps_default_platform_key" ON "provider_apps" USING btree ("provider") WHERE "provider_apps"."project_id" IS NULL AND "provider_apps"."is_default" = true;--> statement-breakpoint
CREATE INDEX "social_connections_profile_provider_health_idx" ON "social_connections" USING btree ("profile_id","provider","health");--> statement-breakpoint
CREATE INDEX "social_connections_environment_idx" ON "social_connections" USING btree ("project_environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_connections_profile_provider_account_key" ON "social_connections" USING btree ("profile_id","provider","provider_account_id") WHERE "social_connections"."disconnected_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "social_credentials_connection_type_key" ON "social_credentials" USING btree ("connection_id","credential_type");--> statement-breakpoint
CREATE INDEX "social_credentials_expiry_idx" ON "social_credentials" USING btree ("expires_at") WHERE "social_credentials"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "social_destinations_connection_provider_id_key" ON "social_destinations" USING btree ("connection_id","provider_destination_id");--> statement-breakpoint
CREATE INDEX "social_destinations_profile_idx" ON "social_destinations" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "social_destinations_environment_idx" ON "social_destinations" USING btree ("project_environment_id");--> statement-breakpoint
CREATE INDEX "media_assets_profile_created_idx" ON "media_assets" USING btree ("profile_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "media_assets_environment_idx" ON "media_assets" USING btree ("project_environment_id");--> statement-breakpoint
CREATE INDEX "media_assets_content_hash_idx" ON "media_assets" USING btree ("project_environment_id","content_hash") WHERE "media_assets"."content_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "media_assets_abandoned_uploads_idx" ON "media_assets" USING btree ("upload_expires_at") WHERE "media_assets"."status" = 'awaiting_upload';--> statement-breakpoint
CREATE UNIQUE INDEX "media_variants_signature_key" ON "media_variants" USING btree ("media_asset_id","transform_signature");--> statement-breakpoint
CREATE INDEX "media_variants_asset_idx" ON "media_variants" USING btree ("media_asset_id");--> statement-breakpoint
CREATE INDEX "post_approvals_post_idx" ON "post_approvals" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_approvals_pending_idx" ON "post_approvals" USING btree ("project_environment_id","requested_at") WHERE "post_approvals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "post_target_attempts_target_number_key" ON "post_target_attempts" USING btree ("post_target_id","attempt_number");--> statement-breakpoint
CREATE INDEX "post_target_attempts_post_idx" ON "post_target_attempts" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_target_attempts_trace_idx" ON "post_target_attempts" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "post_targets_post_idx" ON "post_targets" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_targets_destination_created_idx" ON "post_targets" USING btree ("destination_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_targets_status_next_attempt_idx" ON "post_targets" USING btree ("status","next_attempt_at") WHERE "post_targets"."status" IN ('queued', 'retryable_failed', 'scheduled');--> statement-breakpoint
CREATE INDEX "post_targets_lease_expiry_idx" ON "post_targets" USING btree ("lease_expires_at") WHERE "post_targets"."status" = 'publishing';--> statement-breakpoint
CREATE UNIQUE INDEX "post_targets_post_destination_key" ON "post_targets" USING btree ("post_id","destination_id");--> statement-breakpoint
CREATE INDEX "post_targets_fingerprint_idx" ON "post_targets" USING btree ("destination_id","content_fingerprint") WHERE "post_targets"."content_fingerprint" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "posts_profile_created_idx" ON "posts" USING btree ("profile_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_environment_status_publish_idx" ON "posts" USING btree ("project_environment_id","status","publish_at");--> statement-breakpoint
CREATE INDEX "posts_due_reconciliation_idx" ON "posts" USING btree ("publish_at") WHERE "posts"."status" IN ('scheduled', 'queued');--> statement-breakpoint
CREATE INDEX "posts_trace_idx" ON "posts" USING btree ("trace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_environment_key_key" ON "idempotency_keys" USING btree ("project_environment_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_resource_idx" ON "idempotency_keys" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "outbound_webhook_events_environment_created_idx" ON "outbound_webhook_events" USING btree ("project_environment_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "outbound_webhook_events_aggregate_idx" ON "outbound_webhook_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "outbound_webhook_events_trace_idx" ON "outbound_webhook_events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_next_attempt_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at") WHERE "webhook_deliveries"."status" IN ('pending', 'failed_retryable');--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_created_idx" ON "webhook_deliveries" USING btree ("webhook_endpoint_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_endpoint_key" ON "webhook_deliveries" USING btree ("event_id","webhook_endpoint_id") WHERE "webhook_deliveries"."replay_of_delivery_id" IS NULL;--> statement-breakpoint
CREATE INDEX "webhook_endpoints_environment_idx" ON "webhook_endpoints" USING btree ("project_environment_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_enabled_idx" ON "webhook_endpoints" USING btree ("project_environment_id") WHERE "webhook_endpoints"."status" = 'enabled';--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_subscriptions_endpoint_type_key" ON "webhook_subscriptions" USING btree ("webhook_endpoint_id","event_type");--> statement-breakpoint
CREATE INDEX "feature_flags_key_idx" ON "feature_flags" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_scope_key" ON "feature_flags" USING btree ("key","organization_id","project_id","project_environment_id");--> statement-breakpoint
CREATE INDEX "platform_capabilities_provider_idx" ON "platform_capabilities" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_capabilities_current_key" ON "platform_capabilities" USING btree ("provider") WHERE "platform_capabilities"."superseded_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_compliance_rules_provider_key_key" ON "provider_compliance_rules" USING btree ("provider","rule_key");--> statement-breakpoint
CREATE INDEX "provider_compliance_rules_active_idx" ON "provider_compliance_rules" USING btree ("provider") WHERE "provider_compliance_rules"."retired_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_health_status_provider_key" ON "provider_health_status" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_versions_provider_api_key" ON "provider_versions" USING btree ("provider","api_version");--> statement-breakpoint
CREATE UNIQUE INDEX "api_request_logs_request_id_key" ON "api_request_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "api_request_logs_environment_created_idx" ON "api_request_logs" USING btree ("project_environment_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "api_request_logs_trace_idx" ON "api_request_logs" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_provider_event_id_key" ON "provider_events" USING btree ("provider","provider_event_id") WHERE "provider_events"."provider_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_fingerprint_key" ON "provider_events" USING btree ("provider","fingerprint") WHERE "provider_events"."fingerprint" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "provider_events_unprocessed_idx" ON "provider_events" USING btree ("received_at") WHERE "provider_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "provider_request_logs_trace_idx" ON "provider_request_logs" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "provider_request_logs_environment_created_idx" ON "provider_request_logs" USING btree ("project_environment_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_request_logs_connection_idx" ON "provider_request_logs" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_scope_key" ON "usage_counters" USING btree ("organization_id","project_environment_id","metric","period");--> statement-breakpoint
CREATE INDEX "usage_events_org_date_metric_idx" ON "usage_events" USING btree ("organization_id","usage_date","metric");--> statement-breakpoint
CREATE INDEX "usage_events_environment_date_idx" ON "usage_events" USING btree ("project_environment_id","usage_date");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_resource_metric_key" ON "usage_events" USING btree ("metric","resource_type","resource_id") WHERE "usage_events"."resource_id" IS NOT NULL;