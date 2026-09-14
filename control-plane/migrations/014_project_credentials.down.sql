ALTER TABLE projects
DROP CONSTRAINT projects_credential_id_shape;

ALTER TABLE projects
DROP CONSTRAINT projects_credential_assignment_state_valid;

ALTER TABLE projects
DROP COLUMN credential_assignment_failure;

ALTER TABLE projects
DROP COLUMN credential_assignment_generation;

ALTER TABLE projects
DROP COLUMN credential_assignment_state;

ALTER TABLE projects
DROP COLUMN requested_credential_id;

ALTER TABLE projects
DROP COLUMN credential_id;

ALTER TABLE node_provider_credentials
DROP CONSTRAINT node_provider_credentials_storage_valid;

ALTER TABLE node_provider_credentials
DROP COLUMN storage;
