-- Asterism Control Plane, schema version 1.
--
-- Design notes that are load-bearing rather than stylistic:
--
--   * Enrollment tokens are stored only as a SHA-256 digest. The plaintext value
--     exists exactly once, in the creation response.
--   * A host workspace path is never modelled. The Control Plane addresses work
--     by the Node-local project id; the Node resolves it to a path locally.
--   * `(node_id, node_project_id)` and `(node_id, run_id, seq)` are unique, so
--     duplicate delivery from an at-least-once channel is a no-op insert rather
--     than a correctness problem.
--   * Identity is versioned by `identity_generation`, so a rotation is an
--     atomic bump rather than an in-place key overwrite.
--
-- Rollback: this migration creates only new objects, so rolling back means
-- dropping them in reverse dependency order (see 001_initial.down.sql).
CREATE TABLE nodes (
  node_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  identity_generation INTEGER NOT NULL DEFAULT 1,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  last_seen_at TIMESTAMPTZ,
  last_session_id TEXT,
  software_version TEXT,
  protocol_version INTEGER,
  instance_id TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  connection_state TEXT NOT NULL DEFAULT 'offline',
  draining BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT nodes_connection_state_valid CHECK (
    connection_state IN ('offline', 'online', 'draining', 'stale')
  )
);

-- An active identity must be unique: two live Nodes cannot share a public key.
CREATE UNIQUE INDEX nodes_active_fingerprint ON nodes (fingerprint)
WHERE
  revoked_at IS NULL;

CREATE INDEX nodes_connection_state ON nodes (connection_state);

CREATE TABLE enrollment_tokens (
  token_id TEXT PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by TEXT REFERENCES nodes (node_id),
  revoked_at TIMESTAMPTZ,
  intended_name TEXT,
  purpose TEXT NOT NULL DEFAULT 'enrollment',
  created_by TEXT,
  CONSTRAINT enrollment_tokens_purpose_valid CHECK (purpose IN ('enrollment', 'recovery'))
);

CREATE INDEX enrollment_tokens_open ON enrollment_tokens (expires_at)
WHERE
  consumed_at IS NULL
  AND revoked_at IS NULL;

CREATE TABLE node_sessions (
  session_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes (node_id) ON DELETE CASCADE,
  protocol_version INTEGER,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  authenticated_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  disconnect_reason TEXT,
  instance_id TEXT,
  capabilities_digest TEXT,
  remote_address TEXT,
  last_heartbeat_at TIMESTAMPTZ
);

CREATE INDEX node_sessions_active ON node_sessions (node_id)
WHERE
  disconnected_at IS NULL;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes (node_id) ON DELETE CASCADE,
  node_project_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT projects_unique_per_node UNIQUE (node_id, node_project_id)
);

CREATE INDEX projects_node ON projects (node_id);

CREATE TABLE remote_commands (
  command_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes (node_id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects (project_id) ON DELETE SET NULL,
  command_type TEXT NOT NULL,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  response_payload JSONB,
  error_code TEXT,
  error_payload JSONB,
  dispatch_count INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT,
  idempotency_key TEXT,
  CONSTRAINT remote_commands_state_valid CHECK (
    state IN (
      'queued',
      'dispatched',
      'accepted',
      'completed',
      'failed',
      'rejected',
      'indeterminate'
    )
  )
);

-- Dispatch scans this: pending work for one Node, oldest first.
CREATE INDEX remote_commands_pending ON remote_commands (node_id, created_at)
WHERE
  state IN ('queued', 'dispatched');

CREATE UNIQUE INDEX remote_commands_idempotency ON remote_commands (node_id, idempotency_key)
WHERE
  idempotency_key IS NOT NULL;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes (node_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  -- Assigned by the Node. Absent until the create command is answered.
  node_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  terminal_reason TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_of_run_id TEXT REFERENCES runs (run_id),
  last_event_seq BIGINT NOT NULL DEFAULT 0,
  acked_event_seq BIGINT NOT NULL DEFAULT 0,
  create_command_id TEXT REFERENCES remote_commands (command_id),
  subscribed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX runs_node_run ON runs (node_id, node_run_id)
WHERE
  node_run_id IS NOT NULL;

CREATE INDEX runs_project_created ON runs (project_id, created_at DESC);

CREATE INDEX runs_subscribed ON runs (node_id)
WHERE
  subscribed = TRUE;

CREATE TABLE run_events (
  node_id TEXT NOT NULL REFERENCES nodes (node_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  recorded_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Duplicate delivery from an at-least-once channel becomes a no-op.
  CONSTRAINT run_events_unique UNIQUE (node_id, run_id, seq)
);

CREATE INDEX run_events_run_seq ON run_events (run_id, seq);

CREATE TABLE identity_rotations (
  rotation_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes (node_id) ON DELETE CASCADE,
  old_fingerprint TEXT NOT NULL,
  proposed_public_key TEXT NOT NULL,
  proposed_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  challenge_nonce TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT identity_rotations_state_valid CHECK (
    state IN (
      'pending',
      'completed',
      'failed',
      'expired',
      'revoked'
    )
  )
);

CREATE INDEX identity_rotations_open ON identity_rotations (node_id)
WHERE
  state = 'pending';

-- Append-only. Security-relevant operations only; never payload content.
CREATE TABLE audit_log (
  audit_id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  result TEXT NOT NULL,
  correlation_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_occurred ON audit_log (occurred_at DESC);

CREATE INDEX audit_log_target ON audit_log (target_type, target_id);
