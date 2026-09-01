-- Connecting a server, as a thing the product does rather than a runbook.
--
-- Adding a Node meant an operator bearer token, a hand-issued enrollment token,
-- a project id typed on the server and a long silent download. None of that is
-- describable in the product, so none of it could be shown, resumed or audited.
-- These tables make an installation a durable object: it has an owner, a state,
-- a generation and an append-only history the browser can replay.
--
-- The connection code itself is deliberately absent. It lives where every other
-- capability of its kind already lives — `enrollment_tokens`, digest-only,
-- expiring, single-use, organization-bound — and this table holds only the id of
-- that row. A second credential shape would be a second thing to get right.
CREATE TABLE node_installations (
  installation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  -- What the operator called it. Becomes the Node's display name on enrollment.
  display_name TEXT NOT NULL,
  -- The capability the installer presents. Never the code, only its row.
  token_id TEXT REFERENCES enrollment_tokens (token_id),
  -- Set once the code is redeemed and an identity exists.
  node_id TEXT,
  state TEXT NOT NULL DEFAULT 'code_issued',
  -- A retry starts a new generation rather than rewriting what happened. An
  -- event from an older attempt is then recognisably stale instead of being
  -- applied on top of a newer one.
  generation INTEGER NOT NULL DEFAULT 1,
  -- Monotonic within a generation. Weighted across stages, so it is a real
  -- measure of remaining work rather than a count of steps.
  percent SMALLINT NOT NULL DEFAULT 0,
  -- Only meaningful while downloading, and only ever real byte counts.
  bytes_done BIGINT,
  bytes_total BIGINT,
  failure_code TEXT,
  failure_message TEXT,
  retryable BOOLEAN,
  created_by_user_id TEXT REFERENCES users (user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT node_installations_percent_range CHECK (percent BETWEEN 0 AND 100),
  -- Typed, so the browser switches on a value rather than matching English.
  CONSTRAINT node_installations_state_valid CHECK (
    state IN (
      'code_issued',
      'bootstrap_downloaded',
      'bundle_metadata_fetched',
      'bundle_downloading',
      'bundle_verified',
      'plan_prepared',
      'prerequisites_installing',
      'runtime_installing',
      'configuration_writing',
      'identity_enrolling',
      'services_starting',
      'node_connecting',
      'health_verifying',
      'complete',
      'failed',
      'cancelled',
      'expired'
    )
  )
);

CREATE INDEX node_installations_org_created ON node_installations (organization_id, created_at DESC);

-- One open installation per code.
CREATE UNIQUE INDEX node_installations_token ON node_installations (token_id)
WHERE
  token_id IS NOT NULL;

-- The history the browser replays.
--
-- Append-only and sequenced per installation, which is what makes a reload
-- resume rather than restart: the page asks for everything after the last `seq`
-- it saw, exactly as it already does for run events.
CREATE TABLE node_installation_events (
  installation_id TEXT NOT NULL REFERENCES node_installations (installation_id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  percent SMALLINT NOT NULL,
  bytes_done BIGINT,
  bytes_total BIGINT,
  failure_code TEXT,
  -- Sanitized, structured detail only. No host paths, no command output, no
  -- environment, nothing that arrived as free text from the installer.
  detail JSONB,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, seq),
  CONSTRAINT node_installation_events_percent_range CHECK (percent BETWEEN 0 AND 100)
);

-- Redemption attempts, counted the way failed logins already are.
--
-- Digest only: a table of attempts must not become a table of codes. Counting
-- by source as well as by code is what stops someone walking the code space from
-- one address without tripping any single code's limit.
CREATE TABLE node_installation_attempts (
  attempt_id BIGSERIAL PRIMARY KEY,
  code_digest TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX node_installation_attempts_code_recent ON node_installation_attempts (code_digest, attempted_at DESC);

CREATE INDEX node_installation_attempts_source_recent ON node_installation_attempts (source_digest, attempted_at DESC);
