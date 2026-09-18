ALTER TABLE runs
DROP COLUMN model;

ALTER TABLE projects
DROP CONSTRAINT projects_model_selection_state_valid;

ALTER TABLE projects
DROP COLUMN model_selection_failure;

ALTER TABLE projects
DROP COLUMN model_selection_generation;

ALTER TABLE projects
DROP COLUMN model_selection_state;

ALTER TABLE projects
DROP COLUMN requested_model;

ALTER TABLE projects
DROP COLUMN model;
