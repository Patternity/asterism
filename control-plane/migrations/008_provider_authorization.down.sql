ALTER TABLE nodes
DROP CONSTRAINT IF EXISTS nodes_provider_state_check;

ALTER TABLE nodes
DROP COLUMN IF EXISTS provider_state,
DROP COLUMN IF EXISTS provider_state_at;
