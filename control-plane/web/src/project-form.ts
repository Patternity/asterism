/**
 * What the browser can decide about a new project, and what it may not.
 *
 * These checks exist to answer immediately, not to be a boundary: the server
 * validates the same things and its answer wins. The one place that matters is
 * a repository URL carrying a credential — refused here so it is never typed
 * into a request at all, and never silently rewritten into a "clean" one, which
 * would hide from the operator that they pasted a secret.
 */
import type { NodeRecord, ProvisioningState } from './types';

export const WORKSPACE_MODES = ['empty', 'clone'] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

/** Bounds the server enforces, repeated so the field can say so before submit. */
export const LIMITS = {
  name: 120,
  slug: 64,
  repositoryUrl: 512,
  branch: 255,
} as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Anything a terminal or a log line would interpret rather than print.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface FormValues {
  name: string;
  slug: string;
  nodeId: string;
  mode: WorkspaceMode;
  repositoryUrl: string;
  branch: string;
}

export type FieldErrors = Partial<Record<keyof FormValues, string>>;

/**
 * A conservative ASCII suggestion.
 *
 * Deliberately not transliteration: this console has no such utility, and a
 * wrong guess at another alphabet produces a slug the operator has to notice
 * and undo. Anything it cannot render becomes a separator, and the field stays
 * editable.
 */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.slug);
}

/**
 * Whether this Node can be asked to build a project.
 *
 * Read from the sanitized advertisement, never from a version number: a Node
 * that has not said it supports provisioning would refuse the command, and
 * offering it produces a project that sits pending with no explanation.
 */
export function nodeIsSelectable(node: NodeRecord): boolean {
  return node.node_capabilities?.project_provisioning_available === true;
}

/** Why a Node cannot be chosen, in words an operator can act on. */
export function nodeUnavailableReason(node: NodeRecord): string | null {
  if (nodeIsSelectable(node)) return null;
  if (node.connection_state !== 'online') return 'Offline — cannot accept a new project right now';
  if (node.node_capabilities?.supports_project_provisioning !== true) {
    return 'This Node does not support multiple projects yet';
  }
  return 'Unavailable';
}

export function validate(values: FormValues, modes: readonly string[]): FieldErrors {
  const errors: FieldErrors = {};

  const name = values.name.trim();
  if (name.length === 0) errors.name = 'Give the project a name.';
  else if (name.length > LIMITS.name)
    errors.name = `Keep the name under ${LIMITS.name} characters.`;
  else if (CONTROL.test(name)) errors.name = 'Remove the special characters from the name.';

  const slug = values.slug.trim();
  if (slug.length === 0) errors.slug = 'Give the project a short identifier.';
  else if (slug.length < 2 || slug.length > LIMITS.slug) {
    errors.slug = `Use between 2 and ${LIMITS.slug} characters.`;
  } else if (!SLUG.test(slug)) {
    errors.slug = 'Use lowercase letters, numbers and single dashes.';
  }

  if (!values.nodeId) errors.nodeId = 'Choose a Node to build this project on.';
  if (!modes.includes(values.mode)) errors.mode = 'That workspace option is not available.';

  if (values.mode === 'clone') {
    const url = values.repositoryUrl.trim();
    if (url.length === 0) errors.repositoryUrl = 'Enter the repository to clone.';
    else if (url.length > LIMITS.repositoryUrl) {
      errors.repositoryUrl = `Keep the address under ${LIMITS.repositoryUrl} characters.`;
    } else if (CONTROL.test(url) || /\s/.test(url)) {
      errors.repositoryUrl = 'Remove the spaces from the address.';
    } else if (
      /^[a-z+]+:\/\/[^/@]*:[^/@]*@/.test(url) ||
      /(?:token|password|access_token)=/i.test(url)
    ) {
      // Refused rather than cleaned: rewriting it would hide from the operator
      // that they pasted a secret into a field that reaches the audit trail.
      errors.repositoryUrl =
        'This address contains a password or token. Remove it — the Node uses the Git credentials already set up on the server.';
    }

    const branch = values.branch.trim();
    if (branch.length > LIMITS.branch) {
      errors.branch = `Keep the branch name under ${LIMITS.branch} characters.`;
    } else if (branch.startsWith('-')) {
      errors.branch = 'A branch name cannot begin with a dash.';
    } else if (CONTROL.test(branch) || /\s/.test(branch)) {
      errors.branch = 'Remove the spaces from the branch name.';
    }
  }

  return errors;
}

/**
 * The request body, built from the mode that is actually selected.
 *
 * Repository fields are dropped rather than hidden: a form that keeps sending
 * what it stopped showing is how an empty project acquires a repository nobody
 * asked for.
 */
export function buildCreatePayload(values: FormValues): Record<string, unknown> {
  const workspace: Record<string, unknown> =
    values.mode === 'clone'
      ? {
          mode: 'clone',
          repository_url: values.repositoryUrl.trim(),
          ...(values.branch.trim() ? { branch: values.branch.trim() } : {}),
        }
      : { mode: 'empty' };
  return {
    name: values.name.trim(),
    slug: values.slug.trim(),
    node_id: values.nodeId,
    workspace,
  };
}

/**
 * Typed failures, in words.
 *
 * Keyed by code and never by matching the server's English: the text is for a
 * person, and a message that changed wording would otherwise change behaviour.
 */
const MESSAGES: Record<string, string> = {
  node_offline: 'That Node is not connected right now. Reconnect it and try again.',
  node_capability_unavailable: 'That Node cannot host multiple projects yet.',
  project_slug_conflict: 'Another project in this organization already uses that identifier.',
  workspace_mode_unsupported: 'That Node does not offer this way of creating a workspace.',
  repository_url_invalid: 'That does not look like a repository address.',
  repository_credentials_embedded:
    'The address contains a password or token. Remove it — the Node uses the Git credentials already set up on the server.',
  repository_branch_invalid: 'That branch name cannot be used.',
  repository_authentication_unavailable:
    'The Node could not authenticate with that repository. Check the credentials configured on the server.',
  repository_clone_failed: 'The repository could not be cloned.',
  workspace_creation_failed: 'The Node could not create the project workspace.',
  workspace_conflict: 'That workspace already belongs to another project on this Node.',
  project_inventory_conflict: 'This Node already knows this project under different settings.',
  profile_provision_failed: 'The Node could not prepare this project’s runtime.',
  profile_worker_start_failed: 'The project’s runtime did not start.',
  profile_worker_unhealthy: 'The project’s runtime started but never became ready.',
  profile_port_exhausted: 'This Node has no free slot for another project runtime.',
  project_provision_timeout: 'The Node took too long to finish preparing this project.',
  project_disabled: 'This project is disabled.',
  project_ownership_mismatch: 'This project belongs to a different Node.',
  provisioning_generation_mismatch: 'A newer attempt has already replaced this one.',
  project_not_retryable: 'This project is not in a state that can be retried.',
  project_failure_not_retryable:
    'Retrying will not change this result. Correct the project settings or ask an operator.',
  invalid_project_name: 'That project name cannot be used.',
  invalid_project_slug: 'That identifier cannot be used.',
  node_not_found: 'That Node is not available in this organization.',
  project_pending: 'This project is still waiting to be built.',
  project_provisioning: 'This project is still being prepared.',
  project_provision_failed: 'This project could not be prepared.',
};

/** A safe sentence for any code, known or not. */
export function failureMessage(code: string | null | undefined): string {
  if (!code) return 'Something went wrong.';
  return MESSAGES[code] ?? 'Something went wrong while preparing this project.';
}

/** What the operator is told a project is doing, per durable state. */
export function stateSummary(state: ProvisioningState): string {
  switch (state) {
    case 'pending':
      return 'Queued for its Node.';
    case 'provisioning':
      return 'The Node is preparing the workspace and this project’s own runtime.';
    case 'ready':
      return 'Ready to use.';
    case 'failed':
      return 'Could not be prepared.';
    case 'disabled':
      return 'Disabled by an administrator.';
    default:
      return '';
  }
}

/** States still moving, and therefore worth asking about again. */
export function isSettling(state: ProvisioningState): boolean {
  return state === 'pending' || state === 'provisioning';
}
