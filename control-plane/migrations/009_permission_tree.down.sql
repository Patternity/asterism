DROP INDEX IF EXISTS nodes_by_owner;

ALTER TABLE nodes
DROP COLUMN IF EXISTS owner_user_id;

DROP TABLE IF EXISTS permissions;
