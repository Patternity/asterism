-- Which model a project runs, chosen from what its Node reports it can run.
--
-- Null is the state every project is in when this arrives, and it is a fact
-- rather than a gap: the project runs whatever its Node's runtime defaults to,
-- exactly as it did before anybody could choose. Nothing here picks a model for
-- an existing project, and `model_selection_state` says `legacy_default` so the
-- difference between "never chosen" and "chosen" is visible rather than
-- inferred from a null.
--
-- The provider is deliberately absent. A project's provider is derived from the
-- credential it is assigned; a second column naming one could disagree with it,
-- and then something would have to decide which of the two was true.
ALTER TABLE projects
ADD COLUMN model TEXT;

ALTER TABLE projects
ADD COLUMN requested_model TEXT;

ALTER TABLE projects
ADD COLUMN model_selection_state TEXT NOT NULL DEFAULT 'legacy_default';

ALTER TABLE projects
ADD COLUMN model_selection_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE projects
ADD COLUMN model_selection_failure TEXT;

-- The same vocabulary the credential assignment uses, plus the state every
-- existing row starts in. `failed` means the Node put the previous model back
-- and the project still runs on it; `inconsistent` means it could not say so.
ALTER TABLE projects
ADD CONSTRAINT projects_model_selection_state_valid CHECK (
  model_selection_state IN (
    'legacy_default',
    'applied',
    'pending',
    'failed',
    'inconsistent'
  )
);

-- What a run was actually executed with, recorded when the Node creates it.
--
-- Null is a run in a project that had chosen no model: it ran on the runtime's
-- default. Reading the project's current model after the fact would answer a
-- different question, because a project's model can change between runs.
ALTER TABLE runs
ADD COLUMN model TEXT;
