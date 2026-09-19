-- Credentials in a state this constraint does not know cannot be described by
-- it, and the honest answer for a downgrade is the state they were in before
-- anything could be logged in again: the runtime record decides, and until a
-- Node reports again `required` is what "holding nothing usable" was called.
UPDATE node_provider_credentials
SET
  state = 'required'
WHERE
  state IN (
    'reauthorizing',
    'reauthorization_required',
    'runtime_missing'
  );

ALTER TABLE node_provider_credentials
DROP CONSTRAINT node_provider_credentials_state_valid;

ALTER TABLE node_provider_credentials
ADD CONSTRAINT node_provider_credentials_state_valid CHECK (
  state IN (
    'required',
    'authorizing',
    'authorized',
    'failed',
    'revoked'
  )
);
