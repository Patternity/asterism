-- Access as a tree, so a person can own a Node without owning the organization.
--
-- Until now a member's role was the whole answer: an `admin` could drain, revoke
-- and update every Node in the organization, and a `developer` could add none at
-- all. There was no way to say "this machine is yours" — which is the ordinary
-- case as soon as two people bring their own hardware.
--
-- The resources form a tree, Organization -> Node, and a grant made above
-- applies to everything beneath it. A Project has no grants of its own: it is
-- reached through the Node it runs on, because that is where it physically
-- lives and who supervises it is not a separate question.
--
-- Roles are ordered, not a set: `admin` implies `write` implies `read`. The
-- ordering is what lets resolution answer "the strongest grant that applies"
-- with a comparison rather than a union.
CREATE TABLE permissions (
  permission_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  -- The organization id for an organization grant, the node id for a Node one.
  -- Not a foreign key: it addresses two different tables, and a column that
  -- referenced one of them would silently forbid the other.
  scope_id TEXT NOT NULL,
  role TEXT NOT NULL,
  granted_by TEXT REFERENCES users (user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT permissions_scope_valid CHECK (scope_type IN ('organization', 'node')),
  CONSTRAINT permissions_role_valid CHECK (role IN ('read', 'write', 'admin'))
);

-- One grant per person per resource. A second grant on the same scope is an
-- edit, not an addition: two rows would make "the strongest applicable" depend
-- on which was read first.
CREATE UNIQUE INDEX permissions_unique_grant ON permissions (user_id, scope_type, scope_id);

-- Resolution walks from a resource upward, so it reads by scope.
CREATE INDEX permissions_by_scope ON permissions (scope_type, scope_id);

-- Listing what one person may reach reads by user within a tenant.
CREATE INDEX permissions_by_user ON permissions (organization_id, user_id);

-- Who a Node belongs to.
--
-- Nullable, and it stays nullable: a Node enrolled before this existed has no
-- owner, and inventing one would hand somebody authority nobody granted. An
-- ownerless Node is reachable only through an organization grant, which is
-- exactly what it was reachable through yesterday.
ALTER TABLE nodes
ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL;

CREATE INDEX nodes_by_owner ON nodes (organization_id, owner_user_id)
WHERE
  owner_user_id IS NOT NULL;

-- Existing members keep exactly what they have today, expressed in the new
-- shape: an organization-scoped grant. Nothing gains or loses access in this
-- migration, which is what makes it safe to run before anything reads the table.
--
--   owner, admin -> admin      (they manage members, nodes and projects)
--   developer    -> write      (they create runs, they do not manage the tenant)
--   viewer       -> read
INSERT INTO
  permissions (
    permission_id,
    organization_id,
    user_id,
    scope_type,
    scope_id,
    role
  )
SELECT
  'perm_' || replace(gen_random_uuid()::text, '-', ''),
  m.organization_id,
  m.user_id,
  'organization',
  m.organization_id,
  CASE m.role
    WHEN 'owner' THEN 'admin'
    WHEN 'admin' THEN 'admin'
    WHEN 'developer' THEN 'write'
    ELSE 'read'
  END
FROM
  memberships m
WHERE
  m.disabled_at IS NULL
ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING;
