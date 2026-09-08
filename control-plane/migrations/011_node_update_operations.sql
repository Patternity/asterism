-- An update as a thing the product has, rather than a command it sent.
--
-- `node.update` can only ever mean "accepted and started". The update replaces
-- and restarts the Node that accepted it, so the process holding the command
-- does not survive to report the outcome, and a result that arrived anyway
-- would be a claim about work that had not happened yet. That semantic is
-- correct and is deliberately left alone.
--
-- What was missing is the operation the command starts. It outlives the Node
-- restart, the Control Plane restart and the browser tab, because it lives
-- here rather than in a socket or a page. Success is decided in exactly one
-- place -- the same Node reconnecting and reporting the release that was asked
-- for -- and never by the root unit exiting zero, which only ever meant the
-- updater finished running.
CREATE TABLE node_update_operations (
  operation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes (node_id) ON DELETE CASCADE,
  -- The command that started it. Kept so the two can be read together, and
  -- nullable so a deleted command never takes the history with it.
  command_id TEXT REFERENCES remote_commands (command_id) ON DELETE SET NULL,
  requested_version TEXT NOT NULL,
  -- What the Node reported before this started, so a mismatch reads as a
  -- direction rather than a bare pair of strings.
  previous_version TEXT,
  -- What it reported when it came back. Success is this equalling the request;
  -- anything else is a mismatch worth showing, not a pass.
  reported_version TEXT,
  requested_by_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'queued',
  -- The fine-grained state behind the coarse stage, in the installer's own
  -- vocabulary, so one progress machine serves an install and an update rather
  -- than two that drift.
  detail_state TEXT,
  percent SMALLINT NOT NULL DEFAULT 0,
  bytes_done BIGINT,
  bytes_total BIGINT,
  failure_code TEXT,
  -- Sanitized and typed. Never command output, a host path or an environment.
  failure_message TEXT,
  -- Highest event sequence applied. An event at or below this is a replay of
  -- one already seen, which is what makes redelivery after a restart safe.
  last_seq BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When the stage last changed, which is what a stall is measured from. A
  -- long download is not a stall; a stage that stopped moving is.
  stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminal_at TIMESTAMPTZ,
  CONSTRAINT node_update_operations_percent_range CHECK (percent BETWEEN 0 AND 100),
  -- Typed, so the browser switches on a value rather than matching English.
  -- `awaiting_reconnect` is the one that carries the whole design: the updater
  -- has finished and the answer is not yet known.
  CONSTRAINT node_update_operations_stage_valid CHECK (
    stage IN (
      'queued',
      'accepted',
      'applying',
      'awaiting_reconnect',
      'succeeded',
      'failed',
      'timed_out'
    )
  )
);

CREATE INDEX node_update_operations_node_created ON node_update_operations (node_id, created_at DESC);

-- At most one operation in flight per Node. A second update while one is
-- running is not a queue, it is two updaters racing for the same binary.
CREATE UNIQUE INDEX node_update_operations_one_live_per_node ON node_update_operations (node_id)
WHERE
  stage IN (
    'queued',
    'accepted',
    'applying',
    'awaiting_reconnect'
  );

-- The history the browser replays, and the reason a reload resumes rather than
-- restarts: the page asks for everything after the last `seq` it saw, exactly
-- as it already does for run events and installations.
CREATE TABLE node_update_events (
  operation_id TEXT NOT NULL REFERENCES node_update_operations (operation_id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  stage TEXT NOT NULL,
  detail_state TEXT,
  percent SMALLINT NOT NULL,
  bytes_done BIGINT,
  bytes_total BIGINT,
  failure_code TEXT,
  -- Sanitized, structured detail only. Nothing that arrived as free text from
  -- the updater reaches this column.
  detail JSONB,
  -- When the updater observed it, which can be well before it was delivered:
  -- events written while the Node was restarting arrive on the next connect.
  occurred_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, seq),
  CONSTRAINT node_update_events_percent_range CHECK (percent BETWEEN 0 AND 100)
);
