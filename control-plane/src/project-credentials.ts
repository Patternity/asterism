/**
 * Choosing which of its Node's credentials a project runs on.
 *
 * A project either reads its Node's shared credential pool -- what every project
 * did before this existed, and still does unless somebody chooses otherwise --
 * or exactly one isolated credential of that same Node, selected by id. The
 * pinned runtime cannot be told to use one entry of a shared pool, so an entry
 * of the pool is never something a project can select, however it is labelled.
 *
 * Nothing here is a secret or a location. A credential is named by an opaque id
 * its Node issued, and the Node validates that id again, derives the link it
 * becomes, and is the only authority on whether an assignment took. This module
 * decides what may be asked for and what a run must be refused for, in words a
 * console can show.
 */

import type { CredentialRow } from './node-credentials-repository.js';
import type { CapabilityView } from './provider-capabilities-repository.js';

/** The command the Node executes, versioned so an older Node fails closed. */
export const CREDENTIAL_ASSIGN_COMMAND = 'project.credential.assign';
export const CREDENTIAL_ASSIGN_COMMAND_VERSION = 1;

/**
 * Where an assignment stands.
 *
 * `failed` means the Node put the previous assignment back and it is what the
 * project still runs on. `inconsistent` means it could not say so, and nothing
 * should run until somebody assigns again.
 */
export const ASSIGNMENT_STATES = ['applied', 'pending', 'failed', 'inconsistent'] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export function isAssignmentState(value: unknown): value is AssignmentState {
  return typeof value === 'string' && (ASSIGNMENT_STATES as readonly string[]).includes(value);
}

/**
 * Codes a Node reports for an assignment that did not take.
 *
 * Stored only when known, so a newer Node's code cannot put an unexplained value
 * into durable state; anything else is recorded as `node_refused`.
 */
export const ASSIGNMENT_FAILURES = [
  'credential_id_invalid',
  'credential_not_found',
  'credential_not_isolated',
  'credential_not_authorized',
  'credential_provider_unavailable',
  'credential_home_missing',
  'credential_unavailable',
  'credential_unreadable',
  'credential_link_invalid',
  'credential_link_occupied',
  'credential_paths_unavailable',
  'credential_assignment_in_progress',
  'project_not_ready',
  'project_runs_active',
  'project_state_unreadable',
  'assignment_not_recorded',
  'worker_restart_failed',
  'worker_unhealthy',
  'worker_not_restarted',
  'node_refused',
] as const;

const FAILURES = new Set<string>(ASSIGNMENT_FAILURES);

export function knownAssignmentFailure(code: unknown): string | null {
  return typeof code === 'string' && FAILURES.has(code) ? code : null;
}

/** A refusal an API route can send as it is. */
export interface Refusal {
  status: 404 | 409;
  error: string;
  message: string;
}

/**
 * Why this credential cannot be selected for a project on its Node, or `null`.
 *
 * `credential` is looked up by the project's own Node only, so a credential of
 * another Node or another organization arrives here as `null` and is refused
 * exactly like one that never existed.
 */
export function selectionRefusal(
  credential: CredentialRow | null,
  capabilities: CapabilityView,
  online: boolean,
): Refusal | null {
  if (!credential) {
    return {
      status: 404,
      error: 'credential_not_found',
      message: "That credential is not available on this project's Node.",
    };
  }
  if (credential.storage !== 'isolated') {
    return {
      status: 409,
      error: 'credential_not_selectable',
      message:
        'Credentials in the shared pool cannot be selected by a project. Add a credential to use it on its own.',
    };
  }
  if (credential.state !== 'authorized') {
    return {
      status: 409,
      error: 'credential_not_authorized',
      message: 'That credential is not authorized. Authorize it from the Node page first.',
    };
  }
  if (!online) {
    return {
      status: 409,
      error: 'node_offline',
      message: "This project's Node has to be connected to change its credential.",
    };
  }
  if (
    capabilities.state !== 'reported' ||
    capabilities.status !== 'ok' ||
    !Array.isArray(capabilities.providers)
  ) {
    return {
      status: 409,
      error: 'capabilities_unknown',
      message: "This project's Node has not reported which providers its runtime supports.",
    };
  }
  if (capabilities.stale) {
    return {
      status: 409,
      error: 'capabilities_stale',
      message: "This project's Node has not confirmed its providers since it reconnected.",
    };
  }
  const provider = capabilities.providers.find((entry) => entry.id === credential.provider_id);
  if (!provider || provider.availability !== 'available') {
    return {
      status: 409,
      error: 'credential_provider_unavailable',
      message: "That credential's provider is not available on this project's Node.",
    };
  }
  return null;
}

/** The assignment columns of a project row. */
export interface ProjectCredentialFields {
  project_id: string;
  node_project_id: string;
  credential_id: string | null;
  requested_credential_id: string | null;
  credential_assignment_state: string;
  credential_assignment_generation: number;
  credential_assignment_failure: string | null;
}

/** Why a run would be refused because of the project's credential. */
export interface RunBlock {
  error: string;
  message: string;
}

/**
 * Why a run in this project must be refused before it is dispatched, or `null`.
 *
 * A project on the shared pool is not judged here: whether that pool holds a
 * credential is the Node's provider state, checked where it always was.
 */
export function runCredentialBlock(
  project: ProjectCredentialFields,
  credentials: CredentialRow[],
  capabilities: CapabilityView,
): RunBlock | null {
  const state = isAssignmentState(project.credential_assignment_state)
    ? project.credential_assignment_state
    : 'applied';
  if (state === 'pending') {
    return {
      error: 'credential_assignment_pending',
      message:
        "This project's credential is being changed. Runs can start once its Node confirms the change.",
    };
  }
  if (state === 'inconsistent') {
    return {
      error: 'credential_assignment_inconsistent',
      message:
        "The Node could not confirm which credential this project's runtime is using. Choose its credential again before running.",
    };
  }
  if (!project.credential_id) return null;

  const credential = credentials.find((row) => row.credential_id === project.credential_id);
  if (!credential) {
    return {
      error: 'credential_missing',
      message:
        "This project's credential is no longer reported by its Node. Choose another credential for this project.",
    };
  }
  if (credential.storage !== 'isolated') {
    return {
      error: 'credential_inconsistent',
      message:
        "This project's credential is no longer one a project can use on its own. Choose its credential again.",
    };
  }
  if (credential.state !== 'authorized') {
    return {
      error: 'credential_not_authorized',
      message:
        "This project's credential needs to be authorized again. Authorize it from the Node page, or choose another one.",
    };
  }
  if (
    capabilities.state !== 'reported' ||
    capabilities.status !== 'ok' ||
    !Array.isArray(capabilities.providers)
  ) {
    return {
      error: 'credential_capabilities_unknown',
      message: "This project's Node has not reported which providers its runtime supports.",
    };
  }
  if (capabilities.stale) {
    return {
      error: 'credential_capabilities_stale',
      message: "This project's Node is not connected, so its credential cannot be confirmed.",
    };
  }
  const provider = capabilities.providers.find((entry) => entry.id === credential.provider_id);
  if (!provider || provider.availability !== 'available') {
    return {
      error: 'credential_provider_unavailable',
      message: "This project's credential uses a provider its Node cannot currently reach.",
    };
  }
  return null;
}

/** One credential as a project page shows it. Label and provider, nothing else. */
function describe(credentials: CredentialRow[], credentialId: string | null) {
  if (!credentialId) return null;
  const row = credentials.find((entry) => entry.credential_id === credentialId);
  return {
    credential_id: credentialId,
    label: row?.label ?? null,
    provider_id: row?.provider_id ?? null,
    state: row?.state ?? null,
  };
}

/** What a project reader sees about the credential its runs use. */
export function credentialView(
  project: ProjectCredentialFields,
  credentials: CredentialRow[],
  capabilities: CapabilityView,
) {
  const state = isAssignmentState(project.credential_assignment_state)
    ? project.credential_assignment_state
    : 'applied';
  return {
    mode: project.credential_id ? ('isolated' as const) : ('legacy_shared_pool' as const),
    current: describe(credentials, project.credential_id),
    assignment: {
      state,
      requested:
        state === 'applied'
          ? null
          : {
              mode: project.requested_credential_id
                ? ('isolated' as const)
                : ('legacy_shared_pool' as const),
              credential: describe(credentials, project.requested_credential_id),
            },
      failure: project.credential_assignment_failure,
    },
    run_block: runCredentialBlock(project, credentials, capabilities),
  };
}

/** The payload of the command that applies a project's requested credential. */
export function credentialAssignPayload(project: ProjectCredentialFields) {
  return {
    version: CREDENTIAL_ASSIGN_COMMAND_VERSION,
    project_id: project.project_id,
    node_project_id: project.node_project_id,
    assignment_generation: project.credential_assignment_generation,
    // Null is a request for the shared pool, and is sent as null rather than
    // omitted: a Node must never read "nothing was asked for" as that.
    credential_id: project.requested_credential_id,
  };
}
