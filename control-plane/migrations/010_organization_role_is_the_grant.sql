-- One source per level.
--
-- 009 gave every member an organization-scoped grant mirroring their role. That
-- is a second place to remember, and it fails in the direction that matters: a
-- member demoted from admin to viewer keeps the `admin` row, and keeps the
-- access it carries. Four call sites create or change a membership, and all four
-- would have to remember.
--
-- So the organization level is read from the membership role, where it already
-- lives and always did, and this table holds what memberships cannot express:
-- a grant on one Node.
DELETE FROM permissions
WHERE
  scope_type = 'organization';

ALTER TABLE permissions
DROP CONSTRAINT IF EXISTS permissions_scope_valid;

ALTER TABLE permissions
ADD CONSTRAINT permissions_scope_valid CHECK (scope_type IN ('node'));
