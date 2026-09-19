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
  /**
   * True when the Node advertises moving a project onto one isolated credential.
   * An older Node advertises nothing here, and every project on it stays on the
   * shared pool it already reads.
   */
  supports_project_credentials: boolean;
  supports_project_models: boolean;
  /**
   * Whether this Node can be updated from here at all.
   *
   * Decided by `decideManagedUpdate`, never by a version string: node-2 runs a
   * build that answers `node.update` with `forbidden_command`, and a console
   * that offered the button anyway left an operator watching an update time out
   * against a host that was never going to accept it.
   */
  supports_managed_update: boolean;
  managed_update_available: boolean;
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
/**
 * What a Node has done with `node.update`, for the builds that say nothing.
 *
 * `accepted` is one it answered rather than refused; `refused` is one it
 * rejected or never answered; `unknown` is a Node that has never been asked.
 * Only the most recent settled attempt counts -- an old success does not
 * survive a later refusal, because the host may have been reinstalled on an
 * older build since.
 */
export type ManagedUpdateEvidence = 'accepted' | 'refused' | 'unknown';

/** What a Node says about managed updates, as far as this build can read it. */
export type AdvertisedManagedUpdate =
  /** It advertises that it takes them. */
  | 'yes'
  /** It advertises that it does not. */
  | 'no'
  /** It spoke about updates in a shape this build cannot read. */
  | 'unreadable'
  /** It said nothing about updates at all: a build that predates the field. */
  | 'absent';

/** Read the advertisement without interpreting anything that is not a boolean. */
export function readAdvertisedManagedUpdate(
  capabilities: Record<string, unknown> | null | undefined,
): AdvertisedManagedUpdate {
  if (!capabilities || typeof capabilities !== 'object') return 'absent';
  if (!('updates' in capabilities)) return 'absent';
  const updates = (capabilities as { updates?: unknown }).updates;
  if (updates === null || updates === undefined) return 'absent';
  // A Node that spoke about updates is not a Node that predates them, so
  // anything unreadable here stays unreadable rather than falling back to
  // history written by some other build.
  if (typeof updates !== 'object' || Array.isArray(updates)) return 'unreadable';
  const managed = (updates as { managed?: unknown }).managed;
  if (managed === true) return 'yes';
  if (managed === false) return 'no';
  return 'unreadable';
}

/**
 * Whether a managed update may be offered, and the only place that decides it.
 *
 * Both API call sites and, through them, the console read this one answer;
 * nothing re-derives it from a version, a release tag or a capability blob of
 * its own.
 *
 * It fails closed on purpose, and the order says why:
 *
 * 1. An explicit `yes` is the Node's own word, and it is the answer.
 * 2. An explicit `no` is also the Node's own word. History cannot overrule it:
 *    a host reinstalled on a build that refuses updates would otherwise be
 *    offered one forever on the strength of an update it took last month.
 * 3. An `unreadable` advertisement is not a `yes`. A Node describing updates in
 *    a shape this build does not understand is a Node this build cannot judge.
 * 4. With nothing advertised, the Node predates the field and only history
 *    speaks. It must say `accepted`. `refused` and `unknown` both fail closed,
 *    and so does evidence that is missing or malformed, because the caller that
 *    did not look is exactly the caller that must not be trusted.
 * 5. Evidence is only worth reading about a Node whose capabilities are known.
 *    Before the first handshake, an absent advertisement is ignorance rather
 *    than a fact, and stale history is all that is left.
 *
 * The consequence is deliberate: a legacy Node that has never been asked is
 * never offered an update from here, and its host must be updated directly.
 * The alternative -- offering it on the strength of never having refused --
 * is the guess that produced an operation nobody could complete.
 */
export function decideManagedUpdate(input: {
  advertised: AdvertisedManagedUpdate;
  capabilitiesKnown: boolean;
  evidence: ManagedUpdateEvidence | null | undefined;
}): boolean {
  if (input.advertised === 'yes') return true;
  if (input.advertised !== 'absent') return false;
  if (!input.capabilitiesKnown) return false;
  return input.evidence === 'accepted';
}

/**
 * `updateEvidence` defaults to `unknown`, which forbids a managed update for a
 * Node that advertises nothing. Only the two routes that can offer or accept an
 * update look the evidence up; every other reader gets the closed answer rather
 * than a guess.
 */
export function nodeCapabilityView(
  node: NodeLike,
  updateEvidence: ManagedUpdateEvidence = 'unknown',
): NodeCapabilityView {
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
      | {
          projects?: {
            project_provisioning?: unknown;
            workspace_modes?: unknown;
            credential_assignment?: unknown;
            model_selection?: unknown;
          };
        }
      | undefined
  )?.projects;
  const managedUpdate = decideManagedUpdate({
    advertised: readAdvertisedManagedUpdate(capabilities),
    capabilitiesKnown: known,
    evidence: updateEvidence,
  });
  const provisioning = projects?.project_provisioning === true;
  const credentialAssignment = projects?.credential_assignment === true;
  const modelSelection = projects?.model_selection === true;
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
    supports_project_credentials: credentialAssignment,
    // A Node that never advertised this would refuse the command, so the
    // console must not offer a choice of model against it.
    supports_project_models: modelSelection,
    supports_managed_update: managedUpdate,
    // Supported but offline is not available: the command would sit queued
    // against a Node that cannot answer, and time out exactly as an unsupported
    // one does.
    managed_update_available: managedUpdate && connection === 'online',
  };
}
