-- Uploaded image attachments.
--
-- An attachment is a first-class row rather than a blob inside a run's metadata
-- JSON, because two runs can legitimately point at the same stored image: a
-- retry is another attempt at the same turn and must reuse the bytes rather
-- than copy them. The join table carries the per-turn facts — order and label —
-- which belong to the use, not to the file.
--
-- Image bytes never live here. PostgreSQL holds metadata and a storage key; the
-- bytes are on disk, so backups, restores and quotas can treat them separately
-- and a routine row dump cannot accidentally carry megabytes of pixels.
--
-- Runs that carry a public image URL keep working untouched: those attachments
-- were never rows and still are not. This table is only for what Asterism
-- itself stores.
CREATE TABLE attachments (
  attachment_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (organization_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users (user_id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  original_filename TEXT,
  media_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  -- Of the normalized bytes actually stored, not of what was uploaded: the
  -- upload is re-encoded, so the original digest would describe nothing on disk.
  sha256 TEXT NOT NULL,
  -- Opaque and generated. Never a user-supplied name and never a host path.
  storage_key TEXT NOT NULL UNIQUE,
  -- `ready` is readable; anything else is not served, which is how an
  -- attachment is revoked without deleting the row a run still references.
  state TEXT NOT NULL DEFAULT 'ready',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attachments_kind_valid CHECK (kind IN ('uploaded_image')),
  CONSTRAINT attachments_state_valid CHECK (state IN ('ready', 'disabled')),
  CONSTRAINT attachments_size_positive CHECK (byte_size > 0),
  CONSTRAINT attachments_dimensions_positive CHECK (
    width > 0
    AND height > 0
  ),
  CONSTRAINT attachments_org_project FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, project_id) ON DELETE CASCADE
);

CREATE INDEX attachments_org_project_created ON attachments (organization_id, project_id, created_at DESC);

CREATE TABLE run_attachments (
  run_id TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments (attachment_id) ON DELETE RESTRICT,
  -- What the model sees and what the transcript shows, in that order.
  position INTEGER NOT NULL,
  alt TEXT,
  PRIMARY KEY (run_id, position),
  CONSTRAINT run_attachments_position_bounds CHECK (
    position >= 0
    AND position < 4
  )
);

CREATE INDEX run_attachments_attachment ON run_attachments (attachment_id);
