-- Conversation identity for runs.
--
-- A chat turn is a run, and a conversation is the set of runs sharing a
-- `session_id`. That identifier already travelled end to end — the API accepted
-- it, the Node forwarded it to Hermes — but it lived only inside the opaque
-- `request_metadata` JSONB, so it could not be indexed, filtered, or trusted as
-- a typed field. Promoting it makes the conversation a first-class query.
--
-- Nullable on purpose: every run created before chat existed has no session and
-- stays valid in the operator views.
ALTER TABLE runs
ADD COLUMN session_id TEXT;

-- Backfill from the metadata the API has been writing all along. Empty strings
-- and JSON nulls are not identities and stay NULL.
UPDATE runs
SET
  session_id = request_metadata ->> 'session_id'
WHERE
  request_metadata ? 'session_id'
  AND request_metadata ->> 'session_id' IS NOT NULL
  AND length(trim(request_metadata ->> 'session_id')) > 0;

-- Loading one conversation is "this organization, this project, this session, in
-- order". The partial predicate keeps legacy sessionless runs out of the index.
CREATE INDEX runs_org_project_session ON runs (
  organization_id,
  project_id,
  session_id,
  created_at,
  run_id
)
WHERE
  session_id IS NOT NULL;

-- Resolving a project's active conversation is "the newest run here that has a
-- session", which this serves directly.
CREATE INDEX runs_org_project_session_recent ON runs (organization_id, project_id, created_at DESC)
WHERE
  session_id IS NOT NULL;
