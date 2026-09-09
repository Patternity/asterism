-- What credentials each Node holds, as facts about them.
--
-- Credentials belong to a Node. The secret is a file on one host, usable only
-- by processes on that host, and a model that let it belong to an organization
-- or a project would be describing something that is not true.
--
-- Nothing here is a secret or derived from one. No token, no refresh token, no
-- file, no path, no fingerprint, no device code. What a row holds is what a
-- person needs to tell two credentials apart and decide what to do about them:
-- an opaque id, which provider, what it is called, how it was obtained, and
-- where it stands. The Node is the authority on all of it; this is a copy kept
-- so a console can render without waking a host, and it is replaced wholesale
-- every time the Node says otherwise.
CREATE TABLE node_provider_credentials (
  node_id TEXT NOT NULL REFERENCES nodes (node_id) ON DELETE CASCADE,
  -- The Node's own opaque id. Bounded and closed-alphabet on both sides, so it
  -- can never be read as a path by anything that receives it.
  credential_id TEXT NOT NULL,
  -- Reported by the Node, never checked against a list here: there is no
  -- canonical provider list in this service, by design.
  provider_id TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  -- The Node's clocks, carried through so a person sees when the credential was
  -- made rather than when this row was written.
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, credential_id),
  CONSTRAINT node_provider_credentials_state_valid CHECK (
    state IN (
      'required',
      'authorizing',
      'authorized',
      'failed',
      'revoked'
    )
  )
);

CREATE INDEX node_provider_credentials_node ON node_provider_credentials (node_id, provider_id);
