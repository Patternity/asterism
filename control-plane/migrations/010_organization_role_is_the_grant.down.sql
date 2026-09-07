ALTER TABLE permissions
DROP CONSTRAINT IF EXISTS permissions_scope_valid;

ALTER TABLE permissions
ADD CONSTRAINT permissions_scope_valid CHECK (scope_type IN ('organization', 'node'));
