DROP INDEX IF EXISTS projects_provisioning_state;

DROP INDEX IF EXISTS projects_org_slug;

ALTER TABLE projects
DROP COLUMN IF EXISTS created_by_user_id;

ALTER TABLE projects
DROP COLUMN IF EXISTS repository_branch;

ALTER TABLE projects
DROP COLUMN IF EXISTS repository_url;

ALTER TABLE projects
DROP COLUMN IF EXISTS workspace_mode;

ALTER TABLE projects
DROP COLUMN IF EXISTS provisioning_failure_message;

ALTER TABLE projects
DROP COLUMN IF EXISTS provisioning_failure;

ALTER TABLE projects
DROP COLUMN IF EXISTS provisioning_generation;

ALTER TABLE projects
DROP COLUMN IF EXISTS provisioning_state;

ALTER TABLE projects
DROP COLUMN IF EXISTS slug;
