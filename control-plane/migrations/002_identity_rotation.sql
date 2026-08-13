-- Identity rotation without a wire-protocol change.
--
-- Rotation reuses the HTTP enrollment endpoint rather than adding a command to
-- protocol v1: a Node presenting a rotation token replaces its own key while
-- keeping its `node_id`, so nothing about the authenticated channel changes
-- shape. A rotation token is bound to exactly one Node — an unbound one would
-- let any holder take over an existing identity.
ALTER TABLE enrollment_tokens
DROP CONSTRAINT enrollment_tokens_purpose_valid;

ALTER TABLE enrollment_tokens
ADD CONSTRAINT enrollment_tokens_purpose_valid CHECK (purpose IN ('enrollment', 'recovery', 'rotation'));

ALTER TABLE enrollment_tokens
ADD COLUMN bound_node_id TEXT REFERENCES nodes (node_id) ON DELETE CASCADE;

ALTER TABLE enrollment_tokens
ADD CONSTRAINT enrollment_tokens_rotation_is_bound CHECK (
  purpose <> 'rotation'
  OR bound_node_id IS NOT NULL
);

-- The superseded key is retained so an audit can answer "which key signed this
-- session" after a rotation.
ALTER TABLE identity_rotations
ADD COLUMN old_public_key TEXT;
