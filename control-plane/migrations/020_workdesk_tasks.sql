-- Workdesk: a project's tasks, the Runs that attempt them, and the requests
-- that ask for a change.
--
-- The shape follows one rule: Asterism owns Task state, and everything that
-- merely *asks* for a change is recorded separately from the change itself. A
-- request carries who asked and what they wanted; whether it was accepted is
-- the Control Plane's answer, not the asker's claim.
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',
  -- Bumped on every accepted change. A report from an older Run carries an
  -- older version and is refused rather than applied, so a slow answer from a
  -- superseded attempt cannot overwrite newer state.
  version INTEGER NOT NULL DEFAULT 1,
  -- Bumped once per execution attempt. Version changes for any edit; generation
  -- changes only when work is started again, which is the question a deferred
  -- completion request has to answer: "was this asked for about *this* attempt?"
  generation INTEGER NOT NULL DEFAULT 0,
  -- Whether an accepted explicit outcome may finish this task, or whether a
  -- person must look first. One enum read in one place -- deliberately not a
  -- policy engine.
  completion_policy TEXT NOT NULL DEFAULT 'agent_outcome',
  created_by_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL,
  -- The Run currently attempting this Task, when one is in flight.
  current_run_id TEXT REFERENCES runs (run_id) ON DELETE SET NULL,
  -- Set only when the executing agent explicitly reported which step it is on.
  -- Never inferred from a plan's shape or a message's text.
  current_step_id TEXT,
  -- What the agent said it achieved, and where the deliverables are. Artifact
  -- references are locators the agent reported, not fetched content.
  result_summary TEXT,
  result_artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  result_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Why a Task is waiting or ended badly, in the words shown to a person.
  blocked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_status_known CHECK (
    status IN (
      'backlog',
      'ready',
      'running',
      'waiting_input',
      'review',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  CONSTRAINT tasks_title_present CHECK (length(btrim(title)) > 0),
  CONSTRAINT tasks_completion_policy_known CHECK (
    completion_policy IN ('agent_outcome', 'explicit_review')
  ),
  -- A Task can never address a project in another organization.
  CONSTRAINT tasks_org_project FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id)
);

CREATE INDEX tasks_project_status ON tasks (project_id, status, created_at DESC);

CREATE INDEX tasks_org_updated ON tasks (organization_id, updated_at DESC);

CREATE UNIQUE INDEX tasks_current_run ON tasks (current_run_id)
WHERE
  current_run_id IS NOT NULL;

-- A plan is an ordered list of steps. Steps are a representation of intent:
-- Asterism never creates a Run for a step, so a plan cannot become a second
-- queue of independently executing work.
CREATE TABLE task_plan_steps (
  step_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (task_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  -- Which Run reported this step, so a stale attempt's plan is identifiable.
  reported_by_run_id TEXT REFERENCES runs (run_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_plan_steps_state_known CHECK (
    state IN ('pending', 'in_progress', 'done', 'skipped')
  ),
  CONSTRAINT task_plan_steps_title_present CHECK (length(btrim(title)) > 0),
  CONSTRAINT task_plan_steps_unique_position UNIQUE (task_id, position)
);

CREATE INDEX task_plan_steps_task ON task_plan_steps (task_id, position);

-- A Task has many Runs over its life; a Run attempts at most one Task. The
-- Run's own retry lineage is untouched, so a retry of a Task's Run is still a
-- retry in the Runs history and still belongs to the same Task.
CREATE TABLE task_runs (
  task_id TEXT NOT NULL REFERENCES tasks (task_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  attached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_runs_one_task_per_run PRIMARY KEY (run_id)
);

CREATE INDEX task_runs_task ON task_runs (task_id, attached_at DESC);

-- Something asked for a change. A person, the executing agent, or later an
-- external board. The source is recorded for history and for display; it grants
-- nothing, and every request is answered here.
CREATE TABLE task_requests (
  request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (task_id) ON DELETE CASCADE,
  -- 'user', 'agent' or 'integration'. A label, never an authorization.
  source TEXT NOT NULL,
  -- The person who asked, when a person asked.
  actor_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL,
  -- The Run that asked, when the executing agent asked through its Node.
  actor_run_id TEXT REFERENCES runs (run_id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The Task version the asker believed it was changing.
  observed_version INTEGER,
  -- The execution attempt this was asked about. A completion request is settled
  -- later, against the Run that was running when it was made.
  generation INTEGER,
  -- `pending` is how a completion request waits: asked for, not yet answered,
  -- because the Run it belongs to has not durably finished. It becomes
  -- `accepted` or `rejected` exactly once.
  outcome TEXT NOT NULL,
  -- Why a request was refused, in the words shown to a person.
  outcome_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_requests_source_known CHECK (source IN ('user', 'agent', 'integration')),
  CONSTRAINT task_requests_outcome_known CHECK (outcome IN ('pending', 'accepted', 'rejected')),
  -- A duplicate delivery of the same external request must not execute twice.
  CONSTRAINT task_requests_idempotent UNIQUE (task_id, source, action, request_id)
);

CREATE INDEX task_requests_task ON task_requests (task_id, created_at DESC);

-- At most one completion request may be waiting per attempt, whoever asked.
-- Without this, a Run that called the tool twice would settle twice.
CREATE UNIQUE INDEX task_requests_one_pending_completion ON task_requests (task_id, generation)
WHERE
  outcome = 'pending'
  AND action = 'complete';

-- The executing agent needs a person to answer something. This is deliberately
-- not the runtime's approval mechanism: approving a tool operation and
-- answering a question are different acts with different consequences, and
-- collapsing them would let one stand in for the other.
CREATE TABLE task_input_requests (
  input_request_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (task_id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs (run_id) ON DELETE SET NULL,
  -- What the agent said it needs, and what kind of wall it hit.
  prompt TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'needs_input',
  answered_at TIMESTAMPTZ,
  -- Who answered. `needs_input` means external input is required, not that a
  -- human must supply it, so the source is recorded beside the person and a
  -- non-human answer leaves `answered_by_user_id` null.
  answered_by_source TEXT,
  answered_by_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL,
  answer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_input_requests_kind_known CHECK (
    kind IN (
      'needs_input',
      'capability',
      'transient',
      'dependency'
    )
  ),
  CONSTRAINT task_input_requests_answered_source_known CHECK (
    answered_by_source IS NULL
    OR answered_by_source IN ('user', 'agent', 'integration')
  )
);

CREATE INDEX task_input_requests_open ON task_input_requests (task_id, created_at DESC)
WHERE
  answered_at IS NULL;

-- Confirmed lifecycle, in the words a person reads. Only facts land here: a
-- Run started, a plan was updated, a tool ran under its real name, a result is
-- ready. Anything the agent claimed about itself is stored with
-- `agent_reported` set, so the console can say who said it.
CREATE TABLE task_events (
  task_id TEXT NOT NULL REFERENCES tasks (task_id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  run_id TEXT REFERENCES runs (run_id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  agent_reported BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_events_unique UNIQUE (task_id, seq)
);

CREATE INDEX task_events_task_seq ON task_events (task_id, seq DESC);

-- Every structured report this Control Plane has already taken in.
--
-- The Node's outbox is at-least-once by design: a report that was committed and
-- then lost its socket is sent again on reconnect. The report's identity is
-- deterministic -- the same board row always stamps the same id -- so the second
-- copy collides here and is acknowledged without being applied a second time.
--
-- Separate from `task_events` because not every report becomes an event, and a
-- report that was refused must still be remembered as seen: otherwise it would
-- be retransmitted and re-refused forever.
CREATE TABLE task_reports (
  report_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (task_id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs (run_id) ON DELETE SET NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  accepted BOOLEAN NOT NULL,
  -- Why it was refused, in the words shown against the task.
  refusal_reason TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX task_reports_task ON task_reports (task_id, received_at DESC);

-- Trash: a project in Trash, or under a Node in Trash, takes no new work.
--
-- `refuse_work_in_trash` reads `NEW.node_id`, which a Task does not carry, so
-- this resolves the Node through the project. It takes the same locks in the
-- same order — Node, then project — because two trigger functions disagreeing
-- about lock order is how a deadlock is built.
--
-- Dispatch needs no new door: starting a Task's work inserts a run and a
-- remote command, and both of those tables are already guarded by
-- `refuse_work_in_trash`. Restoring a project therefore runs nothing on its
-- own either; something has to ask again.
CREATE FUNCTION refuse_task_work_in_trash () RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_project TEXT;
  target_node TEXT;
  node_trashed TIMESTAMPTZ;
  project_trashed TIMESTAMPTZ;
BEGIN
  target_project := NEW.project_id;
  IF target_project IS NULL THEN
    RETURN NEW;
  END IF;

  -- The project's Node never changes, so reading the id without a lock is safe;
  -- the tombstones are what must be read under one.
  SELECT node_id INTO target_node FROM projects WHERE project_id = target_project;

  SELECT trashed_at INTO node_trashed FROM nodes WHERE node_id = target_node FOR SHARE;
  IF node_trashed IS NOT NULL THEN
    RAISE EXCEPTION 'node_trashed' USING ERRCODE = 'TR001';
  END IF;

  SELECT trashed_at INTO project_trashed FROM projects WHERE project_id = target_project FOR SHARE;
  IF project_trashed IS NOT NULL THEN
    RAISE EXCEPTION 'project_trashed' USING ERRCODE = 'TR002';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_refuse_in_trash
BEFORE INSERT ON tasks FOR EACH ROW
EXECUTE FUNCTION refuse_task_work_in_trash ();

-- `task_requests` is deliberately NOT guarded. A request that Trash caused to
-- be refused is exactly the row that must survive, with `outcome = 'rejected'`
-- and the reason: refusing the insert would erase the record of the refusal and
-- leave a person wondering whether their click did anything at all.
