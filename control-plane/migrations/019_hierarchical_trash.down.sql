-- Leaving Trash behind restores everything in it: without the columns there is
-- no way to say a resource is hidden, and a downgrade must not make a hidden
-- Node or project unreachable. Their data was never touched, so dropping the
-- tombstones is the whole restoration. Workers put to sleep on a Node stay
-- asleep until that Node is told otherwise, which is the Node's own state and
-- not this database's.
DROP TRIGGER runs_refuse_trash ON runs;

DROP TRIGGER remote_commands_refuse_trash ON remote_commands;

DROP FUNCTION refuse_work_in_trash ();

DROP INDEX projects_trashed;

DROP INDEX nodes_trashed;

ALTER TABLE projects
DROP COLUMN worker_lifecycle_failure;

ALTER TABLE projects
DROP COLUMN worker_lifecycle_command_id;

ALTER TABLE projects
DROP CONSTRAINT projects_worker_lifecycle_valid;

ALTER TABLE projects
DROP COLUMN worker_lifecycle;

ALTER TABLE projects
DROP CONSTRAINT projects_trashed_by_needs_trashed_at;

ALTER TABLE projects
DROP COLUMN trashed_by_user_id;

ALTER TABLE projects
DROP COLUMN trashed_at;

ALTER TABLE nodes
DROP CONSTRAINT nodes_trashed_by_needs_trashed_at;

ALTER TABLE nodes
DROP COLUMN trashed_by_user_id;

ALTER TABLE nodes
DROP COLUMN trashed_at;
