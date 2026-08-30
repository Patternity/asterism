/**
 * What a project's owning Node can actually do.
 *
 * The authenticated capability advertisement is the only source. Version
 * strings, release tags, project metadata, runtime ownership, and the Control
 * Plane's own version are all guesses about a remote process, and a guess that
 * enables a control produces a button whose command the Node will refuse.
 *
 * The handshake carries only a *digest* of the capabilities, so the set itself
 * is requested with `capabilities.get` right after authentication and stored on
 * the node row. That snapshot is durable, so a Node that advertised support and
 * then went offline is still known to support it — it is simply unreachable,
 * which is a different thing and is reported differently.
 */
import { RUN_APPROVAL_POLICIES } from './approval-choices.js';
import { supportedAttachmentTypes, type AttachmentType } from './attachments.js';

/** Capability names this Control Plane understands. Anything else is ignored. */
const KNOWN_POLICIES = new Set<string>(RUN_APPROVAL_POLICIES);

export interface NodeCapabilityView {
  /** Live connection state of the owning Node. */
  connection_status: string;
  /**
   * Whether a handshake has ever completed for this Node.
   *
   * False before the first connection, which is distinct from "connected and
   * advertises nothing": one is unknown, the other is a definite absence, and
   * neither may render a control.
   */
  capabilities_known: boolean;
  /** Sanitized run approval policies the Node advertises. */
  run_approval_policy: string[];
  /** True when the Node explicitly advertises the run-scoped bypass. */
  supports_run_approval_policy: boolean;
  /** True when it is supported *and* the Node can currently be reached. */
  run_approval_policy_available: boolean;
  /** Sanitized attachment types the Node advertises. */
  run_attachments: AttachmentType[];
  /** True when image attachments are supported *and* the Node is reachable. */
  image_attachments_available: boolean;
  /** True when the Node advertises building a project its own Hermes home. */
  supports_project_provisioning: boolean;
  /** Supported *and* currently reachable, which is what provisioning needs. */
  project_provisioning_available: boolean;
  /** Workspace modes the Node advertises. Unknown modes are dropped. */
  workspace_modes: string[];
}

/** Workspace modes this Control Plane knows how to ask for. */
const KNOWN_WORKSPACE_MODES = new Set(['empty', 'clone']);

type NodeLike = {
  connection_state?: string | null;
  capabilities?: Record<string, unknown> | null;
} | null;

/**
 * Derive the sanitized view a project reader is allowed to see.
 *
 * Only known capability names and known values cross this boundary: an unknown
 * future policy is dropped rather than forwarded, so a Node advertising
 * something this Control Plane has never heard of can never light up a control
 * whose meaning is unknown here.
 */
export function nodeCapabilityView(node: NodeLike): NodeCapabilityView {
  const connection = typeof node?.connection_state === 'string' ? node.connection_state : 'unknown';
  const capabilities = node?.capabilities;
  // The handshake seeds this column with `{digest}` before the real set
  // arrives. Counting that as "known" would report a definite absence of
  // capabilities during the window where nothing has been negotiated yet.
  const known = Boolean(
    capabilities &&
      typeof capabilities === 'object' &&
      Object.keys(capabilities).some((key) => key !== 'digest'),
  );

  const approvals = (capabilities as { approvals?: { run_approval_policy?: unknown } } | undefined)
    ?.approvals;
  const advertised = Array.isArray(approvals?.run_approval_policy)
    ? approvals.run_approval_policy.filter(
        (value): value is string => typeof value === 'string' && KNOWN_POLICIES.has(value),
      )
    : [];

  const supported = advertised.includes('allow_all_for_run');
  const attachments = supportedAttachmentTypes(capabilities);

  // Project provisioning, read the same way as every other capability: only an
  // explicit advertisement counts. A Node whose build predates this feature
  // advertises nothing here and keeps serving the projects it already has.
  const projects = (
    capabilities as
      | { projects?: { project_provisioning?: unknown; workspace_modes?: unknown } }
      | undefined
  )?.projects;
  const provisioning = projects?.project_provisioning === true;
  const workspaceModes = Array.isArray(projects?.workspace_modes)
    ? projects.workspace_modes.filter(
        (value): value is string => typeof value === 'string' && KNOWN_WORKSPACE_MODES.has(value),
      )
    : [];

  return {
    connection_status: connection,
    capabilities_known: known,
    run_approval_policy: advertised,
    supports_run_approval_policy: supported,
    // Supported but offline is not available: the command would be queued
    // against a Node that cannot answer, and the operator would be told the
    // bypass is on when nothing is enforcing it.
    run_approval_policy_available: supported && connection === 'online',
    run_attachments: attachments,
    // Same rule as the approval policy: an unreachable Node cannot carry the
    // attachment, and offering the control would produce a refusal.
    image_attachments_available: attachments.includes('image_url') && connection === 'online',
    supports_project_provisioning: provisioning,
    // Provisioning is a conversation, not a queued instruction: the Node has to
    // build a workspace and answer a health check, so an unreachable Node cannot
    // begin one.
    project_provisioning_available: provisioning && connection === 'online',
    workspace_modes: workspaceModes,
  };
}
