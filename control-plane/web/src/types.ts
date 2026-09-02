import type { ProviderState } from './provider-authorization';

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

/** Durable provisioning states a project moves through. */
export type ProvisioningState = 'pending' | 'provisioning' | 'ready' | 'failed' | 'disabled';

/**
 * The sanitized capability view the server derives from a Node's own
 * advertisement. Named booleans rather than raw JSON, so nothing here has to
 * guess what a Node meant.
 */
export interface NodeCapabilityView {
  connection_status: string;
  capabilities_known: boolean;
  run_approval_policy: string[];
  supports_run_approval_policy: boolean;
  run_approval_policy_available: boolean;
  run_attachments: string[];
  image_attachments_available: boolean;
  supports_project_provisioning: boolean;
  project_provisioning_available: boolean;
  workspace_modes: string[];
}

/**
 * A project as the product API renders it.
 *
 * Nothing about the host is here — where the workspace lives, which runtime
 * serves it, which port it listens on — because none of it crosses the Node
 * boundary in the first place.
 */
export interface ProvisionedProject {
  project_id: string;
  name: string;
  slug: string | null;
  node_id: string;
  enabled: boolean;
  available: boolean;
  workspace: { mode: string; repository_url: string | null; branch: string | null } | null;
  provisioning: {
    state: ProvisioningState;
    generation: number;
    failure: string | null;
    failure_message: string | null;
    retryable: boolean;
  };
  can_run: boolean;
  node_online: boolean;
  node_capabilities: NodeCapabilityView;
  /**
   * Whether this project's Node can reach a model at all.
   *
   * Optional because a Control Plane that predates provider states omits it, and
   * `canRun` treats an unstated one as permitted rather than disabling a
   * composer that used to work.
   */
  provider_state?: ProviderState;
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
  /** Present on the list and detail endpoints; absent on older responses. */
  node_capabilities?: NodeCapabilityView;
  /** Absent on responses from a Control Plane that predates provider states. */
  provider_state?: ProviderState;
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
  /**
   * Provisioning, absent on rows written before the feature existed. A project
   * migrated as `ready` is one that was already running, so treating a missing
   * value as ready is a statement of fact rather than an optimistic default.
   */
  slug?: string | null;
  provisioning_state?: ProvisioningState;
  provisioning_generation?: number;
  provisioning_failure?: string | null;
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
