-- Per-destination credentials (plan §21.3, §23).
--
-- `ProviderDestination.credentials` has been part of the adapter contract since the
-- interface was written, with a comment on the Facebook adapter explaining exactly why:
-- "a Meta Page token is not the token that discovered the Page". Nothing stored it.
--
-- That gap is not cosmetic. Facebook's `listManagedPages` returns one access token per
-- Page, and publishing to a Page requires *that* token — the user token which enumerated
-- the Pages cannot post to them. With only connection-level credential storage, the
-- publisher would hand the user token to `publish()` and Meta would reject it with an
-- error about permissions that names nothing useful. The same shape applies to any
-- provider that issues a credential per publishable surface.
--
-- Nullable, so the common case is untouched: Bluesky, Telegram, LinkedIn and Threads
-- store one credential against the connection and nothing here changes for them.
--
-- Two partial unique indexes rather than one composite. A plain
-- `unique (connection_id, destination_id, credential_type)` would not constrain the
-- connection-level rows at all, because Postgres treats NULLs as distinct and would
-- happily accept two access tokens for the same connection — precisely the "which one is
-- current?" ambiguity the original single-index constraint existed to prevent.
-- `NULLS NOT DISTINCT` would also work on PG15+, but partial indexes state the two rules
-- separately and read as what they are.

ALTER TABLE social_credentials
  ADD COLUMN destination_id uuid REFERENCES social_destinations (id) ON DELETE CASCADE;

COMMENT ON COLUMN social_credentials.destination_id IS
  'Set when the provider issues a credential per publishable surface rather than per authorization — a Meta Page access token being the canonical case. NULL means the credential belongs to the connection as a whole.';

DROP INDEX IF EXISTS social_credentials_connection_type_key;

CREATE UNIQUE INDEX social_credentials_connection_type_key
  ON social_credentials (connection_id, credential_type)
  WHERE destination_id IS NULL;

CREATE UNIQUE INDEX social_credentials_destination_type_key
  ON social_credentials (destination_id, credential_type)
  WHERE destination_id IS NOT NULL;

CREATE INDEX social_credentials_destination_idx
  ON social_credentials (destination_id)
  WHERE destination_id IS NOT NULL;
