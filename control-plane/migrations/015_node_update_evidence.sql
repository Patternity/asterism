-- What an update's success rests on, and what its failure was.
--
-- A Node reconnecting on the requested release used to be enough to call an
-- update successful. It is not: node-1 reconnected on the alpha.30 binary while
-- its runtime had been rolled back to alpha.29, and the operation said
-- `succeeded`. Success now needs the updater's own evidence for this exact
-- operation -- the installed binary, the runtime tree's release marker and
-- every service it verified -- and that evidence is kept with the operation.
--
-- Both columns hold typed, schema-validated data from the updater: releases,
-- a revision, process ids, service roles and project ids. Never a path, never
-- command output.
ALTER TABLE node_update_operations
ADD COLUMN evidence JSONB;

-- On failure: which check stopped the update, which service and in what state,
-- and whether the previous installation was restored.
ALTER TABLE node_update_operations
ADD COLUMN failure_detail JSONB;
