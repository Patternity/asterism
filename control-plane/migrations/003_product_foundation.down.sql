DROP INDEX IF EXISTS audit_log_org_occurred;

DROP INDEX IF EXISTS runs_org_created;

DROP INDEX IF EXISTS remote_commands_org_created;

DROP INDEX IF EXISTS enrollment_tokens_org_created;

DROP INDEX IF EXISTS projects_org_seen;

DROP INDEX IF EXISTS nodes_org_state;

ALTER TABLE audit_log
DROP COLUMN IF EXISTS actor_user_id;

ALTER TABLE audit_log
DROP COLUMN IF EXISTS organization_id;

ALTER TABLE runs
DROP CONSTRAINT IF EXISTS runs_org_project;

ALTER TABLE runs
DROP CONSTRAINT IF EXISTS runs_org_node;

ALTER TABLE runs
DROP COLUMN IF EXISTS created_by_user_id;

ALTER TABLE runs
DROP COLUMN IF EXISTS organization_id;

ALTER TABLE remote_commands
DROP CONSTRAINT IF EXISTS remote_commands_org_project;

ALTER TABLE remote_commands
DROP CONSTRAINT IF EXISTS remote_commands_org_node;

ALTER TABLE remote_commands
DROP COLUMN IF EXISTS organization_id;

ALTER TABLE enrollment_tokens
DROP CONSTRAINT IF EXISTS enrollment_tokens_org_node;

ALTER TABLE enrollment_tokens
DROP COLUMN IF EXISTS organization_id;

ALTER TABLE projects
DROP CONSTRAINT IF EXISTS projects_org_node;

ALTER TABLE projects
DROP CONSTRAINT IF EXISTS projects_org_identity;

ALTER TABLE projects
DROP COLUMN IF EXISTS organization_id;

ALTER TABLE nodes
DROP CONSTRAINT IF EXISTS nodes_org_identity;

ALTER TABLE nodes
DROP COLUMN IF EXISTS organization_id;

DROP TABLE IF EXISTS login_attempts;

DROP TABLE IF EXISTS browser_sessions;

DROP TABLE IF EXISTS invitations;

DROP TABLE IF EXISTS memberships;

DROP TABLE IF EXISTS users;

DROP TABLE IF EXISTS organizations;
