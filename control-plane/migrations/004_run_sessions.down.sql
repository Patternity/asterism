DROP INDEX IF EXISTS runs_org_project_session_recent;

DROP INDEX IF EXISTS runs_org_project_session;

-- `request_metadata` kept its copy throughout, so dropping the column loses no
-- conversation identity.
ALTER TABLE runs
DROP COLUMN session_id;
