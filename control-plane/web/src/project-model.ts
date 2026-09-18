/**
 * Which model a project runs, as a form offers it and a page states it.
 *
 * No model and no provider is named in this file. What can be chosen is what
 * the project's own Node reported for the provider its credential belongs to,
 * and everything here reads that report: a Node updated ahead of this console
 * offers models this console has never heard of, and they work.
 *
 * What the report means is stated exactly: the Node can ask its runtime for
 * this model. Whether the account behind the credential may use it is answered
 * when a run asks, and this page never claims otherwise.
 */

import type { ProjectModelView } from './types';

/** How the absence of a choice reads. Never a model name. */
export const RUNTIME_DEFAULT_LABEL = 'The Node’s default';

export interface ModelChoice {
  value: string;
  label: string;
}

/** What this project may be set to, in the order its Node reported them. */
export function modelChoices(view: ProjectModelView | undefined): ModelChoice[] {
  if (!view) return [];
  return view.available.map((model) => ({ value: model.id, label: model.display_name }));
}

/** How one model reads in a sentence: its own name when the Node gave one. */
export function modelName(view: ProjectModelView | undefined, id: string | null): string {
  if (!id) return RUNTIME_DEFAULT_LABEL;
  return view?.available.find((model) => model.id === id)?.display_name ?? id;
}

const FAILURES: Readonly<Record<string, string>> = {
  model_id_invalid: 'the Node would not write that identifier',
  model_not_supported: 'the Node does not run that model on this credential’s provider',
  model_not_applied: 'the runtime did not come back on that model',
  model_not_recorded: 'the Node could not record the choice',
  credential_not_assigned: 'the project runs on no credential of its own',
  credential_not_authorized: 'the credential is not authorized',
  credential_provider_unavailable: 'the credential’s provider is unavailable',
  credential_assignment_in_progress: 'another change was already in progress',
  project_not_ready: 'the project was not ready',
  project_runs_active: 'a run was in progress',
  worker_configuration_unreadable: 'the project’s runtime configuration could not be read',
  worker_configuration_unwritable: 'the project’s runtime configuration could not be written',
  worker_restart_failed: 'the project’s runtime could not be restarted',
  worker_unhealthy: 'the project’s runtime did not come up on that model',
  worker_not_restarted: 'the project’s runtime did not restart',
  node_refused: 'the Node refused the change',
};

export function modelFailureMessage(code: string | null): string {
  return (code && FAILURES[code]) || 'the Node could not apply it';
}

/**
 * One sentence about a change in flight, one that did not take, or a project
 * that has never chosen. `null` when the current state speaks for itself.
 */
export function modelSummary(view: ProjectModelView | undefined): string | null {
  if (!view) return null;
  const target = view.requested ? modelName(view, view.requested) : null;
  switch (view.state) {
    case 'pending':
      return `Switching to ${target}. Runs can start once the Node confirms it.`;
    case 'failed':
      return `The switch to ${target} did not take: ${modelFailureMessage(
        view.failure,
      )}. This project still runs ${modelName(view, view.selected)}.`;
    case 'inconsistent':
      return `The switch to ${target} did not take (${modelFailureMessage(
        view.failure,
      )}), and the Node could not confirm which model the project runs now. Choose its model again before running.`;
    case 'legacy_default':
      return view.failure
        ? `The switch did not take: ${modelFailureMessage(view.failure)}. This project still runs whichever model its Node’s runtime defaults to.`
        : 'This project has never been given a model, so it runs whichever one its Node’s runtime defaults to.';
    default:
      return null;
  }
}
