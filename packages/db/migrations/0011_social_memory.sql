-- Social memory and the closed optimization loop (plan Phase 10).
--
-- Two kinds of memory, and they are different in a way that matters.
--
-- Brand memory is *asserted*. A customer tells us their product names, the claims they will
-- not make, their competitors, the vocabulary they prefer. It is editable, it is never
-- inferred, and it is never overwritten by anything the system observes — a brand that has
-- said it will not claim "the fastest" does not get overruled because a post saying so
-- performed well.
--
-- Performance memory is *derived*. It is computed from analytics we already collect, it is
-- rebuilt rather than edited, and every row carries the sample size it rests on. That last
-- part is the whole design: a "learning" from three posts is noise wearing a hat, and a
-- product that presents it as insight is worse than one that stays quiet. Nothing is
-- emitted below the minimum sample size, and everything that is emitted says how many
-- observations it saw and against what baseline.

CREATE TABLE brand_memory_entries (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  -- product, audience, competitor, vocabulary, campaign, faq, banned_claim (plan Phase 10
  -- "Brand memory"). Typed rather than free-form so a generation step can ask for exactly
  -- the kind it needs instead of receiving a wall of notes.
  kind text NOT NULL,
  -- Short label: the product's name, the competitor's name, the campaign's name. Stored as
  -- the customer typed it.
  label text NOT NULL,
  -- The same label, lowercased and trimmed, and what uniqueness is actually enforced on.
  -- A separate column rather than a `lower(label)` expression index because the upsert has
  -- to name the conflict target, and every query builder worth using can name a column.
  label_key text NOT NULL,
  -- The substance. For a FAQ this is the answer; for a banned claim, the claim.
  body text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brand_memory_entries_kind_check
    CHECK (kind IN ('product', 'audience', 'competitor', 'vocabulary', 'campaign', 'faq', 'banned_claim'))
);

CREATE INDEX brand_memory_entries_profile_kind_idx
  ON brand_memory_entries (profile_id, kind);

-- One label per kind per profile. Two rows both called "Pro plan" is a customer editing
-- the same fact twice, not two products, and a generation step handed both would have to
-- pick one.
CREATE UNIQUE INDEX brand_memory_entries_profile_kind_label_key
  ON brand_memory_entries (profile_id, kind, label_key);

CREATE TABLE performance_observations (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  -- Which network this was learned on. Never aggregated across networks: a video on
  -- TikTok and a video on LinkedIn have nothing in common except the word.
  provider text NOT NULL,
  -- format, posting_hour, posting_weekday. Topic and hook need an extraction step and are
  -- absent until a model provider exists, rather than being guessed at.
  dimension text NOT NULL,
  -- The value within the dimension: 'video', '9', 'tuesday'.
  bucket text NOT NULL,

  -- How many published posts this rests on. Present on every row, and surfaced in the API,
  -- because a lift computed from four posts is not a finding.
  sample_size integer NOT NULL,
  -- Mean of the metric for this bucket, and for the provider as a whole.
  bucket_mean double precision NOT NULL,
  baseline_mean double precision NOT NULL,
  -- bucket_mean / baseline_mean. 1.0 means indistinguishable from the average.
  lift double precision NOT NULL,
  -- engagement_rate when impressions were known for every sample, engagements otherwise.
  -- Recorded because comparing a rate against a count is meaningless, and a reader has to
  -- be able to tell which one they are looking at.
  metric text NOT NULL,
  -- low, medium, high. Derived from sample size alone; nothing here claims significance
  -- it has not tested for.
  confidence text NOT NULL,

  -- The window this was computed over, so an old observation can be recognized as old.
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT performance_observations_confidence_check
    CHECK (confidence IN ('low', 'medium', 'high')),
  CONSTRAINT performance_observations_metric_check
    CHECK (metric IN ('engagement_rate', 'engagements')),
  CONSTRAINT performance_observations_sample_check CHECK (sample_size > 0)
);

-- Rebuilt, not appended: a learning pass replaces the row for a bucket rather than adding
-- a second one, so a reader never has to work out which of five rows is current.
CREATE UNIQUE INDEX performance_observations_key
  ON performance_observations (profile_id, provider, dimension, bucket);

CREATE INDEX performance_observations_profile_idx
  ON performance_observations (profile_id, computed_at DESC);

COMMENT ON COLUMN performance_observations.sample_size IS
  'Published posts behind this observation. Nothing is stored below the minimum sample size (plan Phase 10).';
