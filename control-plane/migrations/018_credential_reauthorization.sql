-- The states a credential can be in once it can be logged into again.
--
-- Three are new and none of them is a variation of `failed`:
--
--   `reauthorizing`            a login is out for a credential that already
--                              exists, to replace what it holds.
--   `reauthorization_required` the Node's runtime reported this grant finished,
--                              in the runtime's own machine-readable vocabulary.
--   `runtime_missing`          the runtime holds no record for this credential.
--                              Nothing was said about the grant; the record was
--                              pruned, or never written. Reading this as a
--                              revocation would claim something nobody reported,
--                              so it is a state of its own all the way to the
--                              console.
--
-- Rewritten rather than extended: a CHECK constraint cannot be added to, and
-- naming every state in one place is what keeps this list and the Node's enum
-- legible as the same list.
ALTER TABLE node_provider_credentials
DROP CONSTRAINT node_provider_credentials_state_valid;

ALTER TABLE node_provider_credentials
ADD CONSTRAINT node_provider_credentials_state_valid CHECK (
  state IN (
    'required',
    'authorizing',
    'authorized',
    'failed',
    'revoked',
    'reauthorizing',
    'reauthorization_required',
    'runtime_missing'
  )
);
