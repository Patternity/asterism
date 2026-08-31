/**
 * Asking a Node to build a project, and knowing whether it did.
 *
 * A project row used to appear the moment an operator asked for one, and
 * nothing distinguished "asked for" from "running". Provisioning makes that
 * difference durable: the Control Plane records the desired state and the Node
 * reports the actual one, and only the Node's authenticated worker health check
 * can produce `ready`.
 *
 * Everything here is product-shaped. Where the workspace lands, which Hermes
 * home serves it, which port its worker listens on and which key opens it are
 * the Node's decisions; none is accepted from a caller and none is stored.
 */

/** The command the Node executes, versioned so an older Node fails closed. */
export const PROVISION_COMMAND = 'project.provision';
export const PROVISION_COMMAND_VERSION = 1;

/** Durable provisioning states, browser-visible. */
export const PROVISIONING_STATES = [
  'pending',
  'provisioning',
  'ready',
  'failed',
  'disabled',
] as const;
export type ProvisioningState = (typeof PROVISIONING_STATES)[number];

/** States from which a run may be created. Deliberately just the one. */
export function canCreateRuns(state: string): boolean {
  return state === 'ready';
}

/** Workspace intents a project may be created with in this version. */
export const WORKSPACE_MODES = ['empty', 'clone'] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

/**
 * Stable failure codes.
 *
 * The Node maps its own errors onto these before sending them, so nothing on
 * this side parses another process's English to decide what happened.
 */
export const PROVISIONING_FAILURES = [
  'node_offline',
  'node_capability_unavailable',
  'project_slug_conflict',
  'workspace_mode_unsupported',
  'repository_url_invalid',
  'repository_credentials_embedded',
  'repository_authentication_unavailable',
  'repository_clone_failed',
  'workspace_creation_failed',
  'workspace_conflict',
  'project_inventory_conflict',
  'profile_provision_failed',
  'profile_worker_start_failed',
  'profile_worker_unhealthy',
  'profile_port_exhausted',
  'project_provision_timeout',
  'project_disabled',
  'project_ownership_mismatch',
  'provisioning_generation_mismatch',
] as const;
export type ProvisioningFailure = (typeof PROVISIONING_FAILURES)[number];

const FAILURES = new Set<string>(PROVISIONING_FAILURES);

/** Keep an unknown future failure code out of durable state. */
export function knownFailure(code: unknown): ProvisioningFailure | null {
  return typeof code === 'string' && FAILURES.has(code) ? (code as ProvisioningFailure) : null;
}

/**
 * Failures worth trying again.
 *
 * A refused capability or a conflicting slug will fail identically forever; a
 * clone that timed out may not. Offering retry on the first kind trains an
 * operator to click a button that cannot work.
 */
const RETRYABLE = new Set<string>([
  'node_offline',
  'repository_authentication_unavailable',
  'repository_clone_failed',
  'workspace_creation_failed',
  'profile_provision_failed',
  'profile_worker_start_failed',
  'profile_worker_unhealthy',
  'profile_port_exhausted',
  'project_provision_timeout',
]);

export function isRetryable(code: string | null): boolean {
  return code !== null && RETRYABLE.has(code);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Anything a terminal, a log line or a unit file would interpret rather than print. */
// Matching control characters is the point: a name or URL carrying one
// reaches logs, terminals and unit files, where it is interpreted rather
// than printed. The rule exists to catch them by accident, not on purpose.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A slug is an identifier an operator types; it is not a path component. */
export function validateSlug(slug: unknown): { ok: true; slug: string } | { ok: false } {
  if (typeof slug !== 'string') return { ok: false };
  const trimmed = slug.trim();
  if (trimmed.length < 2 || trimmed.length > 64) return { ok: false };
  if (!SLUG.test(trimmed)) return { ok: false };
  return { ok: true, slug: trimmed };
}

export function validateName(name: unknown): { ok: true; name: string } | { ok: false } {
  if (typeof name !== 'string') return { ok: false };
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) return { ok: false };
  // A control character in a display name reaches logs, terminals and the
  // console; there is no reason for one to be in a project's name.
  if (CONTROL.test(trimmed)) return { ok: false };
  return { ok: true, name: trimmed };
}

/**
 * A repository URL that carries no credential and no shell.
 *
 * Credentials in a URL end up in the project row, in audit entries and in
 * anything that renders the project, so they are refused here rather than
 * redacted later. The Node clones with argument-safe execution regardless; this
 * check exists so the value is never *stored*.
 */
export function validateRepositoryUrl(
  value: unknown,
):
  | { ok: true; url: string }
  | { ok: false; reason: 'repository_url_invalid' | 'repository_credentials_embedded' } {
  if (typeof value !== 'string') return { ok: false, reason: 'repository_url_invalid' };
  const url = value.trim();
  if (url.length === 0 || url.length > 512) return { ok: false, reason: 'repository_url_invalid' };
  if (CONTROL.test(url) || /\s/.test(url)) return { ok: false, reason: 'repository_url_invalid' };

  // `user:password@host` in any scheme form. The SCP syntax legitimately
  // contains one `@`, so the test is for a credential separator before it.
  if (/^[a-z+]+:\/\/[^/@]*:[^/@]*@/.test(url)) {
    return { ok: false, reason: 'repository_credentials_embedded' };
  }
  if (/(?:token|password|access_token)=/i.test(url)) {
    return { ok: false, reason: 'repository_credentials_embedded' };
  }

  const https = /^https:\/\/[^/@\s]+\/\S+$/;
  const ssh = /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?[^/@\s]+(?::\d+)?\/\S+$/;
  // The SCP-like form git accepts: user@host:path, with no scheme.
  const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:\S+$/;
  if (https.test(url) || ssh.test(url) || scp.test(url)) return { ok: true, url };
  return { ok: false, reason: 'repository_url_invalid' };
}

/**
 * A branch name that cannot become an option.
 *
 * A leading dash turns an argument into a flag even under argument-safe
 * execution, because the safety is about the shell and not about git's own
 * parser.
 */
export function validateBranch(value: unknown): { ok: true; branch: string } | { ok: false } {
  if (typeof value !== 'string') return { ok: false };
  const branch = value.trim();
  if (branch.length === 0 || branch.length > 255) return { ok: false };
  if (branch.startsWith('-')) return { ok: false };
  if (CONTROL.test(branch) || /[\s~^:?*[\\]/.test(branch)) return { ok: false };
  if (branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    return { ok: false };
  }
  return { ok: true, branch };
}

/**
 * Whether a result belongs to the attempt currently in flight.
 *
 * A Node that reconnects mid-provisioning can deliver the outcome of an attempt
 * the operator has already retried past. Accepting it would mark the newer
 * attempt ready on the strength of an older one, and the project would claim a
 * worker nobody started.
 */
export function isCurrentGeneration(stored: number, reported: unknown): boolean {
  return typeof reported === 'number' && Number.isInteger(reported) && reported === stored;
}
