-- Rollback for schema version 1: drop in reverse dependency order.
--
-- Destructive by definition. Intended for development and for aborting a failed
-- upgrade before any Node has enrolled; it is not a data-preserving operation.
DROP TABLE IF EXISTS audit_log;

DROP TABLE IF EXISTS identity_rotations;

DROP TABLE IF EXISTS run_events;

DROP TABLE IF EXISTS runs;

DROP TABLE IF EXISTS remote_commands;

DROP TABLE IF EXISTS projects;

DROP TABLE IF EXISTS node_sessions;

DROP TABLE IF EXISTS enrollment_tokens;

DROP TABLE IF EXISTS nodes;
