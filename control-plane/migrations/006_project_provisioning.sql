-- Provisioning a project onto a Node that already exists.
--
-- The project row already carried identity, ownership and its Node. What it
-- could not say was whether the Node had actually built anything: a row existed
-- the moment an operator asked for one, and nothing distinguished "asked for"
-- from "running". These columns make that difference durable, so the console can
-- refuse to open a project whose workspace and Hermes home do not exist yet.
--
-- Nothing here describes the host. Where the workspace lives, which Hermes home
-- serves it, which port its worker listens on and which key opens it are the
-- Node's own business and are deliberately absent: the Control Plane addresses a
-- project by id and never by path.

ALTER TABLE projects
ADD COLUMN slug TEXT;

-- Unique per organization rather than globally: two tenants naming a project
-- `website` is ordinary, and a global constraint would leak one tenant's naming
-- into another's failures.
CREATE UNIQUE INDEX projects_org_slug ON projects (organization_id, slug)
WHERE slug IS NOT NULL;

ALTER TABLE projects
ADD COLUMN provisioning_state TEXT NOT NULL DEFAULT 'ready'
    CHECK (provisioning_state IN ('pending', 'provisioning', 'ready', 'failed', 'disabled'));

-- Every project that existed before this migration is already running, so the
-- default above is a statement of fact. Newly created projects state `pending`
-- explicitly rather than inheriting it.

-- Which attempt an event belongs to.
--
-- A Node that reconnects mid-provisioning can deliver the result of an attempt
-- the operator has already retried past. Without a generation the older result
-- would mark the newer attempt ready, and the project would claim a worker that
-- was never started.
ALTER TABLE projects
ADD COLUMN provisioning_generation INTEGER NOT NULL DEFAULT 0;

-- Typed and sanitized. The Node maps its own errors to a stable code before
-- sending them, so nothing here parses a foreign process's English.
ALTER TABLE projects
ADD COLUMN provisioning_failure TEXT;

ALTER TABLE projects
ADD COLUMN provisioning_failure_message TEXT;

ALTER TABLE projects
ADD COLUMN workspace_mode TEXT
    CHECK (workspace_mode IS NULL OR workspace_mode IN ('empty', 'clone'));

-- Product metadata, shown back to the operator. Validated to carry no
-- credentials before it is ever stored.
ALTER TABLE projects
ADD COLUMN repository_url TEXT;

ALTER TABLE projects
ADD COLUMN repository_branch TEXT;

ALTER TABLE projects
ADD COLUMN created_by_user_id TEXT REFERENCES users (user_id);

CREATE INDEX projects_provisioning_state ON projects (organization_id, provisioning_state);
