-- One isolated credential per project, selected by id.
--
-- A reported credential now says where its secret lives: `isolated`, in a home
-- of its own that a project can select, or `legacy_shared_pool`, an entry in the
-- Hermes pool every legacy project reads and none can address one entry of.
-- Every row that exists when this runs was reported by a Node that only had the
-- shared pool, which is why that is the default: a statement of fact about those
-- rows, not a guess about new ones.
ALTER TABLE node_provider_credentials
ADD COLUMN storage TEXT NOT NULL DEFAULT 'legacy_shared_pool';

ALTER TABLE node_provider_credentials
ADD CONSTRAINT node_provider_credentials_storage_valid CHECK (storage IN ('isolated', 'legacy_shared_pool'));

-- The credential a project's worker reads, as its Node last confirmed it. Null
-- is the shared pool, and every project that exists when this runs stays there
-- until somebody reassigns it.
--
-- An opaque id, never a path; the owning Node validates it again every time it
-- is used. No foreign key: a Node's report replaces its credential rows
-- wholesale, and an assignment must survive a report that omits what it names.
-- The run guard refuses such a project meanwhile, rather than the database
-- quietly erasing a choice somebody made.
ALTER TABLE projects
ADD COLUMN credential_id TEXT;

-- What was asked for, while it is being applied or after it failed to apply.
ALTER TABLE projects
ADD COLUMN requested_credential_id TEXT;

ALTER TABLE projects
ADD COLUMN credential_assignment_state TEXT NOT NULL DEFAULT 'applied';

-- Which request a Node's result belongs to. A result for a request that has
-- since been replaced matches nothing and moves nothing.
ALTER TABLE projects
ADD COLUMN credential_assignment_generation INTEGER NOT NULL DEFAULT 0;

-- A typed code from the Node. Never another process's text.
ALTER TABLE projects
ADD COLUMN credential_assignment_failure TEXT;

ALTER TABLE projects
ADD CONSTRAINT projects_credential_assignment_state_valid CHECK (
  credential_assignment_state IN ('applied', 'pending', 'failed', 'inconsistent')
);

ALTER TABLE projects
ADD CONSTRAINT projects_credential_id_shape CHECK (
  (
    credential_id IS NULL
    OR credential_id ~ '^[a-z0-9-]{1,64}$'
  )
  AND (
    requested_credential_id IS NULL
    OR requested_credential_id ~ '^[a-z0-9-]{1,64}$'
  )
);
