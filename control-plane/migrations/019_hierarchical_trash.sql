-- Trash for Nodes and projects: reversible, and never a deletion.
--
-- A tombstone is a time and a person, on the row it describes. Nothing about
-- the resource is rewritten or removed: its identity, enrollment, workspace,
-- credential assignment, model, runs, events and audit stay exactly where they
-- were, and restoring it is clearing two columns.
--
-- The hierarchy is derived, not copied. A project is effectively in Trash when
-- its own tombstone is set *or* its Node's is. Trashing a Node therefore writes
-- one row, and restoring it cannot accidentally restore a project somebody put
-- in Trash on its own -- that project's own tombstone was never touched.
--
-- None of this is overloaded onto an existing column. Connection, provisioning,
-- revocation and enablement each already mean something, and a Trash that was
-- one of them would be indistinguishable from that thing.
ALTER TABLE nodes
ADD COLUMN trashed_at TIMESTAMPTZ;

ALTER TABLE nodes
ADD COLUMN trashed_by_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL;

-- Who trashed it only exists for something trashed. The person may later be
-- deleted, which leaves a tombstone with no author and is still a tombstone.
ALTER TABLE nodes
ADD CONSTRAINT nodes_trashed_by_needs_trashed_at CHECK (
  trashed_by_user_id IS NULL
  OR trashed_at IS NOT NULL
);

ALTER TABLE projects
ADD COLUMN trashed_at TIMESTAMPTZ;

ALTER TABLE projects
ADD COLUMN trashed_by_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL;

ALTER TABLE projects
ADD CONSTRAINT projects_trashed_by_needs_trashed_at CHECK (
  trashed_by_user_id IS NULL
  OR trashed_at IS NOT NULL
);

-- What Trash last did to a project's worker, as the Node reported it.
--
-- Null is a project Trash never touched. The rest are either a transition
-- still on its way or an outcome somebody observed: `stopped` is a unit seen
-- inactive, `running` a worker that answered its health check, `not_managed` a
-- runtime this Node does not own and so did not touch, `unsupported` a Node
-- whose build has no command for this, so nothing on the host was changed and
-- nothing is claimed to have been.
ALTER TABLE projects
ADD COLUMN worker_lifecycle TEXT;

ALTER TABLE projects
ADD CONSTRAINT projects_worker_lifecycle_valid CHECK (
  worker_lifecycle IS NULL
  OR worker_lifecycle IN (
    'stopping',
    'stopped',
    'stop_failed',
    'starting',
    'running',
    'start_failed',
    'not_managed',
    'unsupported'
  )
);

ALTER TABLE projects
ADD COLUMN worker_lifecycle_command_id TEXT;

-- A typed code the Node reported for a transition that did not happen.
ALTER TABLE projects
ADD COLUMN worker_lifecycle_failure TEXT;

CREATE INDEX nodes_trashed ON nodes (organization_id)
WHERE
  trashed_at IS NOT NULL;

CREATE INDEX projects_trashed ON projects (organization_id)
WHERE
  trashed_at IS NOT NULL;

-- The last line of the gate, and the one no code path can forget.
--
-- Every route refuses work for something in Trash before it gets here. This
-- holds when a request raced the tombstone: it takes a share lock on the Node
-- and project rows, and trashing takes an exclusive one, so either the work is
-- written first and the trash sees it, or the tombstone is written first and
-- the work is refused. There is no order in which both succeed.
--
-- The one command that must reach something in Trash is the one that puts its
-- worker to sleep.
CREATE FUNCTION refuse_work_in_trash () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  node_trashed TIMESTAMPTZ;
  project_trashed TIMESTAMPTZ;
  command_type TEXT;
BEGIN
  IF TG_TABLE_NAME = 'remote_commands' THEN
    command_type := NEW.command_type;
    IF command_type = 'project.suspend' THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT trashed_at INTO node_trashed FROM nodes WHERE node_id = NEW.node_id FOR SHARE;
  IF node_trashed IS NOT NULL THEN
    RAISE EXCEPTION 'node_trashed' USING ERRCODE = 'TR001';
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    SELECT trashed_at INTO project_trashed FROM projects WHERE project_id = NEW.project_id FOR SHARE;
    IF project_trashed IS NOT NULL THEN
      RAISE EXCEPTION 'project_trashed' USING ERRCODE = 'TR002';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER remote_commands_refuse_trash
BEFORE INSERT ON remote_commands FOR EACH ROW
EXECUTE FUNCTION refuse_work_in_trash ();

CREATE TRIGGER runs_refuse_trash
BEFORE INSERT ON runs FOR EACH ROW
EXECUTE FUNCTION refuse_work_in_trash ();
