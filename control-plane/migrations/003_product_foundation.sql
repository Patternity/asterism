-- Phase H product foundation: users, organizations, browser sessions, and
-- explicit tenant ownership for every Control Plane record.
--
-- Existing Phase G data is assigned to one deterministic bootstrap
-- organization. This migration never deletes, rewrites, or re-identifies a
-- Node, project, command, run, event, session, rotation, or audit record.
CREATE TABLE organizations (
  organization_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO
  organizations (organization_id, slug, display_name)
VALUES
  (
    'org_bootstrap',
    'bootstrap',
    'Bootstrap Organization'
  );

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  normalized_email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE memberships (
  organization_id TEXT NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT memberships_role_valid CHECK (role IN ('owner', 'admin', 'developer', 'viewer'))
);

CREATE INDEX memberships_user_active ON memberships (user_id, organization_id)
WHERE
  disabled_at IS NULL;

CREATE TABLE invitations (
  invitation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  normalized_email TEXT NOT NULL,
  intended_role TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  invited_by TEXT NOT NULL REFERENCES users (user_id),
  CONSTRAINT invitations_role_valid CHECK (
    intended_role IN ('owner', 'admin', 'developer', 'viewer')
  )
);

CREATE UNIQUE INDEX invitations_one_open_per_email ON invitations (organization_id, normalized_email)
WHERE
  accepted_at IS NULL
  AND revoked_at IS NULL;

CREATE INDEX invitations_open ON invitations (organization_id, expires_at)
WHERE
  accepted_at IS NULL
  AND revoked_at IS NULL;

CREATE TABLE browser_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE,
  csrf_digest TEXT NOT NULL,
  active_organization_id TEXT REFERENCES organizations (organization_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  source_address TEXT,
  user_agent TEXT
);

CREATE INDEX browser_sessions_active ON browser_sessions (user_id, absolute_expires_at)
WHERE
  revoked_at IS NULL;

-- Login attempts store an email digest, never the submitted address or
-- password. Rows are short-lived operational security metadata.
CREATE TABLE login_attempts (
  attempt_id BIGSERIAL PRIMARY KEY,
  account_digest TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX login_attempts_account_recent ON login_attempts (account_digest, attempted_at DESC);

CREATE INDEX login_attempts_source_recent ON login_attempts (source_digest, attempted_at DESC);

-- Assign every Phase G record to the bootstrap organization before making the
-- ownership columns mandatory.
ALTER TABLE nodes
ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_bootstrap' REFERENCES organizations (organization_id);

ALTER TABLE nodes
ADD CONSTRAINT nodes_org_identity UNIQUE (organization_id, node_id);

ALTER TABLE projects
ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_bootstrap' REFERENCES organizations (organization_id);

ALTER TABLE projects
ADD CONSTRAINT projects_org_identity UNIQUE (organization_id, project_id);

ALTER TABLE projects
ADD CONSTRAINT projects_org_node FOREIGN KEY (organization_id, node_id) REFERENCES nodes (organization_id, node_id);

ALTER TABLE enrollment_tokens
ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_bootstrap' REFERENCES organizations (organization_id);

ALTER TABLE enrollment_tokens
ADD CONSTRAINT enrollment_tokens_org_node FOREIGN KEY (organization_id, bound_node_id) REFERENCES nodes (organization_id, node_id);

ALTER TABLE remote_commands
ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_bootstrap' REFERENCES organizations (organization_id);

ALTER TABLE remote_commands
ADD CONSTRAINT remote_commands_org_node FOREIGN KEY (organization_id, node_id) REFERENCES nodes (organization_id, node_id);

ALTER TABLE remote_commands
ADD CONSTRAINT remote_commands_org_project FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id);

ALTER TABLE runs
ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_bootstrap' REFERENCES organizations (organization_id),
ADD COLUMN created_by_user_id TEXT REFERENCES users (user_id);

ALTER TABLE runs
ADD CONSTRAINT runs_org_node FOREIGN KEY (organization_id, node_id) REFERENCES nodes (organization_id, node_id);

ALTER TABLE runs
ADD CONSTRAINT runs_org_project FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id);

ALTER TABLE audit_log
ADD COLUMN organization_id TEXT NOT NULL DEFAULT 'org_bootstrap' REFERENCES organizations (organization_id),
ADD COLUMN actor_user_id TEXT REFERENCES users (user_id);

CREATE INDEX nodes_org_state ON nodes (organization_id, connection_state);

CREATE INDEX projects_org_seen ON projects (organization_id, last_seen_at DESC);

CREATE INDEX enrollment_tokens_org_created ON enrollment_tokens (organization_id, created_at DESC);

CREATE INDEX remote_commands_org_created ON remote_commands (organization_id, created_at DESC);

CREATE INDEX runs_org_created ON runs (organization_id, created_at DESC, run_id DESC);

CREATE INDEX audit_log_org_occurred ON audit_log (organization_id, occurred_at DESC, audit_id DESC);
