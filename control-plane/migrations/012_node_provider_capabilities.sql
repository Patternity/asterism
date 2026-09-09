-- What each Node says its runtime supports.
--
-- Stored, not decided. The Node is the source of truth for which providers its
-- installed runtime can reach, because support means *that host's* launcher is
-- present, Asterism has code driving the authorization, and a run through it
-- works -- none of which is visible from here. This table is a record of what
-- was reported, and the Control Plane owns exactly two things about it: whether
-- the shape could be read, and when.
--
-- One row per Node, replaced on each report. A history of capability snapshots
-- would be a history of the same sentence: what matters is what the runtime
-- installed *now* supports, and the previous answer describes a runtime that is
-- no longer there.
CREATE TABLE node_provider_capabilities (
  node_id TEXT PRIMARY KEY REFERENCES nodes (node_id) ON DELETE CASCADE,
  -- Whether this build could read the shape the Node sent. `unsupported_schema`
  -- is kept rather than discarded: a Node speaking a newer contract is a fact an
  -- operator needs, and silently storing nothing would be indistinguishable from
  -- a Node that never spoke.
  status TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  -- The release whose runtime the snapshot describes. Null when the shape could
  -- not be read far enough to learn it.
  runtime_release TEXT,
  -- Exactly what the Node reported, after bounds. Never rewritten, never
  -- reconciled against a list here, because there is no list here.
  providers JSONB,
  -- When the Node observed it, which is not when it arrived: a Node that was
  -- offline reports on reconnect, and the age of the claim is what makes a
  -- snapshot readable as stale.
  reported_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT node_provider_capabilities_status_valid CHECK (status IN ('ok', 'unsupported_schema')),
  CONSTRAINT node_provider_capabilities_schema_positive CHECK (schema_version >= 1)
);
