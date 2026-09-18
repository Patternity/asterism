-- Letting an operator put a finished update result away.
--
-- The node detail page shows the last update operation, which is right while it
-- runs and right for a while after it ends: a reload must find the result
-- rather than an empty panel. It was wrong forever. A failed update from weeks
-- ago stayed on the page as the Node's current news, with nothing to press, and
-- on a host that cannot take a managed update at all it could never be
-- superseded by a later one.
--
-- Null means nobody has put it away yet. Acknowledging is not deleting: the
-- operation, its events and its failure stay exactly as they were and remain
-- readable by id. Only the page stops leading with it.
ALTER TABLE node_update_operations
ADD COLUMN acknowledged_at TIMESTAMPTZ;

ALTER TABLE node_update_operations
ADD COLUMN acknowledged_by_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL;

-- A running update cannot be put away, and the database says so rather than
-- trusting every caller to check. Hiding one in flight would leave an operator
-- with no sign that their host is being replaced.
ALTER TABLE node_update_operations
ADD CONSTRAINT node_update_operations_acknowledged_terminal CHECK (
  acknowledged_at IS NULL
  OR terminal_at IS NOT NULL
);
