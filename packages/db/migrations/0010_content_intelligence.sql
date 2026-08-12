-- Content Intelligence and universal repurposing (plan Phase 4B, sections 63F-63Q).
--
-- The promise: create once, understand once, adapt intelligently, publish everywhere. This
-- schema exists to make the middle two auditable rather than magical.
--
-- Sources are versioned, not overwritten. An extraction is only valid for the exact text it
-- read: span ids are positional and stable *within a version*, so a claim grounded in span
-- 12 of yesterday's article is not grounded in span 12 of today's. Overwriting a source
-- would silently re-point every existing citation at different words, which is precisely
-- the failure plan P18 exists to prevent.
--
-- `content_hash` is what stops unchanged content being re-analyzed (plan section 63R). A
-- feed re-read hourly is the normal case, and paying for an extraction each time is both
-- wasteful and a source of drift: two extractions of identical text will not be identical.
--
-- Drafts start unapproved. Plan P20 says automation defaults to review, and a draft set
-- that arrived publishable would make that principle a comment rather than a behaviour.

CREATE TABLE content_sources (
  id uuid PRIMARY KEY,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  profile_id uuid REFERENCES profiles (id) ON DELETE CASCADE,

  -- url, rss, upload, text. Discovery differs; everything downstream does not.
  kind text NOT NULL,
  url text,
  name text,
  -- draft_only, approval_required, auto_publish_if_safe (plan section 63T). Defaults to
  -- approval_required, per P20.
  automation_mode text NOT NULL DEFAULT 'approval_required',
  last_fetched_at timestamptz,
  next_fetch_at timestamptz,
  disabled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT content_sources_automation_check
    CHECK (automation_mode IN ('draft_only', 'approval_required', 'auto_publish_if_safe'))
);

CREATE INDEX content_sources_environment_idx ON content_sources (project_environment_id);
CREATE INDEX content_sources_due_idx ON content_sources (next_fetch_at)
  WHERE disabled_at IS NULL AND next_fetch_at IS NOT NULL;

CREATE TABLE source_items (
  id uuid PRIMARY KEY,
  content_source_id uuid NOT NULL REFERENCES content_sources (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  url text,
  title text,
  published_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A feed re-read hourly returns the same items. Without this, each read would create a new
-- item and generate a fresh set of drafts for content nobody republished.
CREATE UNIQUE INDEX source_items_source_external_key
  ON source_items (content_source_id, external_id);

CREATE TABLE source_item_versions (
  id uuid PRIMARY KEY,
  source_item_id uuid NOT NULL REFERENCES source_items (id) ON DELETE CASCADE,
  -- SHA-256 of the normalized text. The whole deduplication story rests on this.
  content_hash text NOT NULL,
  normalized_text text NOT NULL,
  -- Spans, as produced by splitIntoSpans. Frozen with the version, because the ids in an
  -- extraction only mean anything against exactly these.
  spans jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- True when the ingested text pattern-matched a prompt-injection attempt (section 63S).
  -- A signal for review, never a gate: detection is the weakest of the three defenses.
  injection_suspected boolean NOT NULL DEFAULT false,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX source_item_versions_item_hash_key
  ON source_item_versions (source_item_id, content_hash);
CREATE INDEX source_item_versions_item_fetched_idx
  ON source_item_versions (source_item_id, fetched_at DESC);

COMMENT ON COLUMN source_item_versions.content_hash IS
  'SHA-256 of the normalized text. Unchanged content is never re-analyzed (plan 63R).';

CREATE TABLE content_extractions (
  id uuid PRIMARY KEY,
  source_item_version_id uuid NOT NULL REFERENCES source_item_versions (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,

  content_type text,
  title text,
  one_sentence_summary text,
  -- key_points, facts, statistics, quotes, entities, calls_to_action, each carrying the
  -- source_span_ids that support it (section 63I).
  extraction jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Which model produced this, and under which prompt. Required by section 63R, and the
  -- thing that makes "why did the output change last Tuesday" answerable at all.
  model text,
  model_version text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  -- True when the source was too long and was cut. An extraction of truncated text is not
  -- an extraction of that source, and a reader has to be able to tell.
  input_truncated boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX content_extractions_version_key
  ON content_extractions (source_item_version_id);

CREATE TABLE brand_profiles (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  tone text,
  audience text,
  -- Words and claims this brand will not make. Enforced as a check on generated drafts
  -- rather than only as a prompt instruction, because a prompt is a request and a check is
  -- a guarantee.
  banned_phrases text[] NOT NULL DEFAULT '{}'::text[],
  required_disclosures text[] NOT NULL DEFAULT '{}'::text[],
  style_notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX brand_profiles_profile_key ON brand_profiles (profile_id);

CREATE TABLE social_draft_sets (
  id uuid PRIMARY KEY,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  content_extraction_id uuid REFERENCES content_extractions (id) ON DELETE SET NULL,

  -- draft, ready_for_review, approved, published, discarded. Starts as draft: P20 says
  -- automation defaults to review, and a set that arrived approved would make that a
  -- comment rather than a behaviour.
  status text NOT NULL DEFAULT 'draft',
  -- Set when a generated claim could not be traced to a source span (P18). A set with this
  -- true is never eligible for automatic publishing, whatever the automation mode says.
  grounding_failed boolean NOT NULL DEFAULT false,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT social_draft_sets_status_check
    CHECK (status IN ('draft', 'ready_for_review', 'approved', 'published', 'discarded'))
);

CREATE INDEX social_draft_sets_environment_idx
  ON social_draft_sets (project_environment_id, created_at DESC);

CREATE TABLE social_drafts (
  id uuid PRIMARY KEY,
  draft_set_id uuid NOT NULL REFERENCES social_draft_sets (id) ON DELETE CASCADE,
  destination_id uuid REFERENCES social_destinations (id) ON DELETE SET NULL,
  provider text NOT NULL,

  body text NOT NULL,
  media_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  -- The post created from this draft, once somebody published it.
  post_id uuid REFERENCES posts (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX social_drafts_set_idx ON social_drafts (draft_set_id);

-- Every factual claim in a draft, and the spans that support it. This table is what makes
-- "prove this sentence came from the source" a query rather than a judgement call.
CREATE TABLE draft_grounding_claims (
  id uuid PRIMARY KEY,
  social_draft_id uuid NOT NULL REFERENCES social_drafts (id) ON DELETE CASCADE,
  claim_text text NOT NULL,
  claim_kind text NOT NULL DEFAULT 'fact',
  source_span_ids text[] NOT NULL DEFAULT '{}'::text[],
  verified boolean NOT NULL DEFAULT false,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX draft_grounding_claims_draft_idx ON draft_grounding_claims (social_draft_id);

-- Ungrounded claims are the query somebody runs before trusting the pipeline, and they are
-- a small fraction of rows.
CREATE INDEX draft_grounding_claims_unverified_idx
  ON draft_grounding_claims (social_draft_id)
  WHERE verified = false;

-- Immutable record of every model call (plan section 63R): which model, which prompt
-- version, what it cost. Without it, "why did the output change last Tuesday" is
-- unanswerable, and so is the bill.
CREATE TABLE llm_runs (
  id uuid PRIMARY KEY,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  purpose text NOT NULL,
  model text NOT NULL,
  model_version text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  outcome text NOT NULL,
  error_code text,
  resource_type text,
  resource_id uuid,
  trace_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_runs_environment_created_idx
  ON llm_runs (project_environment_id, created_at DESC);
CREATE INDEX llm_runs_resource_idx ON llm_runs (resource_type, resource_id);
