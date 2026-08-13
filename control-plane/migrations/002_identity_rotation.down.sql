ALTER TABLE identity_rotations
DROP COLUMN old_public_key;

ALTER TABLE enrollment_tokens
DROP CONSTRAINT enrollment_tokens_rotation_is_bound;

ALTER TABLE enrollment_tokens
DROP COLUMN bound_node_id;

ALTER TABLE enrollment_tokens
DROP CONSTRAINT enrollment_tokens_purpose_valid;

-- A down migration is explicitly destructive and v1 cannot represent rotation
-- tokens. Remove those rows before restoring the narrower v1 constraint.
DELETE FROM enrollment_tokens
WHERE
  purpose = 'rotation';

ALTER TABLE enrollment_tokens
ADD CONSTRAINT enrollment_tokens_purpose_valid CHECK (purpose IN ('enrollment', 'recovery'));
