export interface OrganizationSummary {
  organization_id: string;
  slug: string;
  display_name: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
}

export interface SessionResponse {
  user: { user_id: string; email: string; display_name: string };
  active_organization: OrganizationSummary | null;
  permissions: string[];
  csrf_token?: string;
}

export interface NodeRecord {
  node_id: string;
  display_name: string;
  connection_state: string;
  last_seen_at: string | null;
  software_version: string | null;
  protocol_version: number | null;
  identity_generation: number;
  fingerprint: string;
  capabilities: Record<string, unknown>;
  draining: boolean;
  revoked_at: string | null;
}

export interface ProjectRecord {
  project_id: string;
  node_id: string;
  node_project_id: string;
  display_name: string;
  enabled: boolean;
  available: boolean;
  first_seen_at: string;
  last_seen_at: string;
  metadata: Record<string, unknown>;
}

export interface RunRecord {
  run_id: string;
  node_id: string;
  project_id: string;
  node_run_id: string | null;
  status: string;
  request_metadata: {
    input_length?: number;
    session_id?: string | null;
    /** Images the operator attached to this turn. */
    attachments?: unknown;
  } | null;
  created_by_user_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  terminal_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_of_run_id: string | null;
  replacement_run_id?: string | null;
  last_event_seq: number | string;
}

export interface RunEvent {
  run_id: string;
  seq: number | string;
  event_type: string;
  recorded_at: string | null;
  ingested_at: string;
  payload: Record<string, unknown>;
}

export interface MemberRecord {
  user_id: string;
  email: string;
  display_name: string;
  enabled: boolean;
  role: OrganizationSummary['role'];
  disabled_at: string | null;
}

export interface InvitationRecord {
  invitation_id: string;
  email: string;
  intended_role: OrganizationSummary['role'];
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export interface AuditRecord {
  audit_id: number;
  occurred_at: string;
  action: string;
  actor: string;
  target_type: string | null;
  target_id: string | null;
  result: string;
  correlation_id: string | null;
  detail: Record<string, unknown>;
}
