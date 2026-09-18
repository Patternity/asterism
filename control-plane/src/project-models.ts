/**
 * Choosing which model a project runs.
 *
 * A project runs on one credential, and that credential belongs to one
 * provider. The model is chosen from what the project's own Node reports it can
 * run *on that provider*, and the provider itself is never chosen: it is
 * derived, so there is nothing that can contradict the credential.
 *
 * There is no model list in this file, and there must never be one. Which
 * models exist is a property of the runtime installed on that host and changes
 * when that host is updated; a list here would be a second authority that is
 * wrong in exactly the cases that matter -- a Node updated ahead of the Control
 * Plane, or behind it. What this module owns is narrower: what may be asked
 * for, given what the Node last reported, and what a person is told when it may
 * not.
 *
 * What the Node's report means is also narrow, and this module never widens it.
 * A model in the snapshot means the installed runtime can be asked for it. It
 * does not mean the credential is authorized, and it does not mean the account
 * behind it may use that model: only a real request answers that, and when it
 * is refused the refusal belongs to the run.
 */

import type { CapabilityView } from './provider-capabilities-repository.js';

/** The command the Node executes, versioned so an older Node fails closed. */
export const MODEL_SELECT_COMMAND = 'project.model.select';
export const MODEL_SELECT_COMMAND_VERSION = 1;

/**
 * Where a selection stands.
 *
 * `legacy_default` is a project that has never chosen: it runs whatever its
 * runtime defaults to, which is what every project did before this existed.
 * `failed` means the Node put the previous model back and it is what the
 * project still runs on. `inconsistent` means it could not say so, and nothing
 * should run until somebody chooses again.
 */
export const MODEL_SELECTION_STATES = [
  'legacy_default',
  'applied',
  'pending',
  'failed',
  'inconsistent',
] as const;
export type ModelSelectionState = (typeof MODEL_SELECTION_STATES)[number];

export function isModelSelectionState(value: unknown): value is ModelSelectionState {
  return typeof value === 'string' && (MODEL_SELECTION_STATES as readonly string[]).includes(value);
}

/**
 * Codes a Node reports for a selection that did not take.
 *
 * Stored only when known, so a newer Node's code cannot put an unexplained
 * value into durable state; anything else is recorded as `node_refused`.
 */
export const MODEL_SELECTION_FAILURES = [
  'model_id_invalid',
  'model_not_supported',
  'model_not_applied',
  'model_not_recorded',
  'credential_not_assigned',
  'credential_id_invalid',
  'credential_not_found',
  'credential_not_isolated',
  'credential_not_authorized',
  'credential_provider_unavailable',
  'credential_home_missing',
  'credential_unavailable',
  'credential_unreadable',
  'credential_paths_unavailable',
  'credential_assignment_in_progress',
  'project_not_ready',
  'project_runs_active',
  'project_state_unreadable',
  'worker_configuration_unreadable',
  'worker_configuration_unwritable',
  'worker_restart_failed',
  'worker_unhealthy',
  'worker_not_restarted',
  'node_refused',
] as const;

const FAILURES = new Set<string>(MODEL_SELECTION_FAILURES);

export function knownModelFailure(code: unknown): string | null {
  return typeof code === 'string' && FAILURES.has(code) ? code : null;
}

/** The longest a model identifier may be, matching what the Node accepts. */
const MAX_MODEL_ID = 64;
const MODEL_ID_PATTERN = /^[A-Za-z0-9.:_-]+$/;

/**
 * The identifier, if it is shaped like one.
 *
 * A shape and not a list, for the same reason there is no catalogue here. What
 * this refuses is anything that could mean something else where the identifier
 * is written -- the Node writes it into its worker's configuration file.
 */
export function validateModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_MODEL_ID || !MODEL_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/** A refusal an API route can send as it is. */
export interface Refusal {
  status: 404 | 409;
  error: string;
  message: string;
}

/** The model columns of a project row, and the credential the provider comes from. */
export interface ProjectModelFields {
  project_id: string;
  node_project_id: string;
  credential_id: string | null;
  model: string | null;
  requested_model: string | null;
  model_selection_state: string;
  model_selection_generation: number;
  model_selection_failure: string | null;
}

/**
 * Why this model cannot be chosen for this project, or `null`.
 *
 * The order is the order a person needs: what the project is missing first,
 * then what its Node has not told us, then the model itself. A stale or
 * unreadable snapshot refuses everything -- a choice made against capabilities
 * that may no longer hold is a choice made against nothing.
 */
export function modelSelectionRefusal(
  providerId: string | null,
  model: string,
  capabilities: CapabilityView,
  online: boolean,
): Refusal | null {
  if (!providerId) {
    return {
      status: 409,
      error: 'credential_not_assigned',
      message:
        'Choose the credential this project runs on first. Its provider decides which models are offered.',
    };
  }
  if (!online) {
    return {
      status: 409,
      error: 'node_offline',
      message: "This project's Node has to be connected to change its model.",
    };
  }
  // Read, and in a shape this build does not have: a different thing from a
  // Node that never reported, and said differently.
  if (capabilities.state === 'reported' && capabilities.status === 'unsupported_schema') {
    return {
      status: 409,
      error: 'capabilities_unsupported',
      message:
        "This project's Node reports its runtime in a format this Control Plane cannot read. Update the Control Plane.",
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
      message: "This project's Node has not reported which models its runtime can run.",
    };
  }
  if (capabilities.stale) {
    return {
      status: 409,
      error: 'capabilities_stale',
      message: "This project's Node has not confirmed its runtime since it reconnected.",
    };
  }
  const provider = capabilities.providers.find((entry) => entry.id === providerId);
  if (!provider || provider.availability !== 'available') {
    return {
      status: 409,
      error: 'credential_provider_unavailable',
      message: "That credential's provider is not available on this project's Node.",
    };
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  if (models.length === 0) {
    return {
      status: 409,
      error: 'model_selection_unavailable',
      message: "This project's Node offers no choice of model for that provider.",
    };
  }
  if (!models.some((candidate) => candidate.id === model)) {
    return {
      status: 409,
      error: 'model_not_reported',
      message: "This project's Node does not report that model for that credential's provider.",
    };
  }
  return null;
}

/** Why a run would be refused because of the project's model. */
export interface RunBlock {
  error: string;
  message: string;
}

/**
 * Why a run in this project must be refused because of its model, or `null`.
 *
 * Only the two states where what the worker runs is not known: one being
 * applied, and one the Node could not put back. A project running the runtime's
 * default is not judged here -- that is what every project did before a model
 * could be chosen, and it still works.
 */
export function runModelBlock(project: ProjectModelFields): RunBlock | null {
  const state = isModelSelectionState(project.model_selection_state)
    ? project.model_selection_state
    : 'legacy_default';
  if (state === 'pending') {
    return {
      error: 'model_selection_pending',
      message:
        "This project's model is being changed. Runs can start once its Node confirms the change.",
    };
  }
  if (state === 'inconsistent') {
    return {
      error: 'model_selection_inconsistent',
      message:
        "The Node could not confirm which model this project's runtime is using. Choose its model again before running.",
    };
  }
  return null;
}

/** What the Node is asked to do, in the shape the command takes. */
export function modelSelectPayload(project: ProjectModelFields) {
  return {
    version: MODEL_SELECT_COMMAND_VERSION,
    project_id: project.project_id,
    node_project_id: project.node_project_id,
    selection_generation: project.model_selection_generation,
    model: project.requested_model,
  };
}

/** What a project's model is, for a page and for an operator. */
export interface ModelView {
  /** Why a run cannot start because of the model, if that is so. */
  run_block: RunBlock | null;
  /** What the Node confirmed it runs, or `null` for the runtime's default. */
  selected: string | null;
  /** What was asked for and is not confirmed yet. */
  requested: string | null;
  state: ModelSelectionState;
  failure: string | null;
  /**
   * The provider the choice is made on, derived from the assigned credential
   * and never stored beside the model.
   */
  provider_id: string | null;
  /** What this Node currently reports for that provider, if it can be trusted. */
  available: { id: string; display_name: string }[];
  /** Why no choice can be made right now, if that is so. */
  blocked: { error: string; message: string } | null;
}

/**
 * The model half of a project, assembled from the project row, the provider its
 * credential belongs to, and what its Node last reported.
 *
 * `available` is empty unless the snapshot is fresh, readable and names the
 * provider: offering a list that may no longer hold would invite a choice the
 * Node would then refuse.
 */
export function modelView(
  project: ProjectModelFields,
  providerId: string | null,
  capabilities: CapabilityView,
  online: boolean,
): ModelView {
  const state = isModelSelectionState(project.model_selection_state)
    ? project.model_selection_state
    : 'legacy_default';
  const blocked = modelSelectionRefusalForView(providerId, capabilities, online);
  const provider =
    providerId && capabilities.state === 'reported' && Array.isArray(capabilities.providers)
      ? capabilities.providers.find((entry) => entry.id === providerId)
      : undefined;
  return {
    run_block: runModelBlock(project),
    selected: project.model ?? null,
    requested: state === 'pending' ? (project.requested_model ?? null) : null,
    state,
    failure: project.model_selection_failure ?? null,
    provider_id: providerId,
    available: blocked || !provider ? [] : (provider.models ?? []),
    blocked: blocked ? { error: blocked.error, message: blocked.message } : null,
  };
}

/** The same refusals as a change, minus the model itself. */
function modelSelectionRefusalForView(
  providerId: string | null,
  capabilities: CapabilityView,
  online: boolean,
): Refusal | null {
  const refusal = modelSelectionRefusal(providerId, ' never', capabilities, online);
  // The sentinel is not a model any Node can report, so reaching the last
  // refusal means everything up to the model itself was fine.
  return refusal && refusal.error === 'model_not_reported' ? null : refusal;
}
