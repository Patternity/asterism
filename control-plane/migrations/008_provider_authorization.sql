-- Whether a Node can reach a model, kept apart from whether it is online.
--
-- A Node with no provider credential is healthy infrastructure that cannot
-- execute a run. Collapsing the two into one notion is what let a project be
-- called ready while every run it accepted was guaranteed to fail inside Hermes,
-- with an error the console could have predicted before creating anything.
--
-- Only the typed state is stored. The device code a person types in a browser is
-- a temporary secret and lives in memory on the Control Plane for as long as it
-- is valid; it is never written here, because a code in a table outlives the
-- ninety seconds it was useful for.
ALTER TABLE nodes
ADD COLUMN IF NOT EXISTS provider_state TEXT NOT NULL DEFAULT 'unknown',
ADD COLUMN IF NOT EXISTS provider_state_at TIMESTAMPTZ;

ALTER TABLE nodes
DROP CONSTRAINT IF EXISTS nodes_provider_state_check;

-- Spelled out rather than free text: the console and the run guard both branch
-- on this, and a value neither recognises would be treated as neither.
ALTER TABLE nodes
ADD CONSTRAINT nodes_provider_state_check CHECK (
  provider_state IN (
    'unknown',
    'unavailable',
    'required',
    'authorizing',
    'authorized',
    'failed'
  )
);
