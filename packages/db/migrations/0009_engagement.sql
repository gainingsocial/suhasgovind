-- Unified comments, conversations and contacts (plan Phase 7).
--
-- The rule that shapes this: do not use the provider API as the live backing store for
-- every UI page. Events arrive by webhook, are persisted here, and the dashboard reads
-- this. Backfill exists for what the webhooks missed, not as the primary path.
--
-- Sharper here than for analytics, because an inbox is refreshed constantly: a page that
-- fetches from six providers on every load burns a rate limit publishing needs and takes
-- seconds to render a list the customer scrolls in milliseconds.
--
-- Contacts are per destination, not global. The same human on Instagram and LinkedIn is
-- two contacts, because there is no reliable way to know they are the same person and
-- asserting it would merge two strangers the first time two handles collide.
--
-- `handled_at` is ours, not a provider concept. It is what turns a firehose into an inbox
-- somebody can actually clear.

CREATE TABLE contacts (
  id uuid PRIMARY KEY,
  destination_id uuid NOT NULL REFERENCES social_destinations (id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_contact_id text NOT NULL,
  display_name text,
  handle text,
  avatar_url text,
  is_self boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contacts_destination_external_key
  ON contacts (destination_id, external_contact_id);
CREATE INDEX contacts_profile_idx ON contacts (profile_id);

CREATE TABLE comments (
  id uuid PRIMARY KEY,
  external_post_row_id uuid REFERENCES external_posts (id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES social_destinations (id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_comment_id text NOT NULL,
  external_parent_id text,
  parent_comment_id uuid REFERENCES comments (id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL,
  body text,
  like_count integer,
  reply_count integer,
  posted_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  deleted_detected_at timestamptz,
  handled_at timestamptz,
  handled_by text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Ingestion is at-least-once: a webhook redelivery and a backfill both bring the same
-- comment. Without this the inbox shows duplicates and reply counts climb on their own.
CREATE UNIQUE INDEX comments_destination_external_key
  ON comments (destination_id, external_comment_id);

CREATE INDEX comments_post_posted_idx ON comments (external_post_row_id, posted_at DESC);
CREATE INDEX comments_parent_idx ON comments (parent_comment_id);

-- The inbox query: what is waiting, newest first. Partial, because handled is the eventual
-- state of almost every row and indexing them all would be mostly dead weight.
CREATE INDEX comments_unhandled_idx
  ON comments (project_environment_id, posted_at DESC)
  WHERE handled_at IS NULL AND deleted_detected_at IS NULL;

COMMENT ON COLUMN comments.handled_at IS
  'Ours, not a provider concept. What turns a firehose into an inbox somebody can clear.';

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  destination_id uuid NOT NULL REFERENCES social_destinations (id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_thread_id text NOT NULL,
  contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL,
  subject text,
  last_message_at timestamptz,
  last_message_preview text,
  unread_count integer NOT NULL DEFAULT 0,
  handled_at timestamptz,
  archived_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX conversations_destination_thread_key
  ON conversations (destination_id, external_thread_id);

CREATE INDEX conversations_inbox_idx
  ON conversations (project_environment_id, last_message_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  project_environment_id uuid NOT NULL REFERENCES project_environments (id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_message_id text NOT NULL,
  contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL,
  direction text NOT NULL,
  body text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  sent_by_user_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT messages_direction_check CHECK (direction IN ('inbound', 'outbound'))
);

CREATE UNIQUE INDEX messages_conversation_external_key
  ON messages (conversation_id, external_message_id);

CREATE INDEX messages_conversation_sent_idx ON messages (conversation_id, sent_at DESC);
