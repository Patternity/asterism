/**
 * Authorizing a Node's model provider, as the console sees it.
 *
 * Kept apart from Node health on purpose. An online Node with no provider
 * credential is working infrastructure that cannot execute a run, and a console
 * that showed one green badge for both would be telling a person their project
 * is ready when the next thing they type is guaranteed to fail.
 */

export const PROVIDER_STATES = [
  'unknown',
  'unavailable',
  'required',
  'authorizing',
  'authorized',
  'failed',
] as const;

export type ProviderState = (typeof PROVIDER_STATES)[number];

export interface ProviderAuthorizationView {
  node_id: string;
  state: ProviderState;
  provider: string | null;
  supported: boolean;
  device: {
    verification_uri: string;
    user_code: string;
    expires_at: string;
  } | null;
}

/** What each state means for the person reading it. */
const LABELS: Record<ProviderState, string> = {
  unknown: 'Not reported',
  unavailable: 'No provider runtime on this Node',
  required: 'Authorization required',
  authorizing: 'Waiting for approval',
  authorized: 'Authorized',
  failed: 'Authorization failed',
};

export function providerLabel(state: ProviderState): string {
  return LABELS[state] ?? state.replace(/_/g, ' ');
}

/** One sentence about what this state means for running anything. */
const EXPLANATIONS: Record<ProviderState, string> = {
  unknown: 'This Node has not said whether it can reach a model.',
  unavailable:
    'This Node has no model provider installed, so it cannot run anything. Repairing the installation is the way out.',
  required:
    'This Node is installed and connected but has no model credential yet. Projects on it can be created, and runs will be refused until it is authorized.',
  authorizing: 'Waiting for someone to approve the code in a browser.',
  authorized: 'This Node holds a model credential. Every project on it uses the same one.',
  failed: 'The last authorization did not complete. Starting it again is safe.',
};

export function providerExplanation(state: ProviderState): string {
  return EXPLANATIONS[state] ?? EXPLANATIONS.unknown;
}

/**
 * Whether runs can be dispatched to a Node in this state.
 *
 * `unknown` passes, matching the Control Plane: a Node that predates provider
 * reporting has said nothing, and disabling every composer on it would break
 * working projects to enforce a check the Node cannot answer.
 */
export function canRun(state: ProviderState): boolean {
  return state === 'authorized' || state === 'unknown';
}

/** Whether the console should offer to start an authorization. */
export function canAuthorize(view: { state: ProviderState; supported: boolean }): boolean {
  if (!view.supported) return false;
  return view.state === 'required' || view.state === 'failed' || view.state === 'unknown';
}

export function isProviderState(value: unknown): value is ProviderState {
  return typeof value === 'string' && (PROVIDER_STATES as readonly string[]).includes(value);
}

/** How long a displayed code is still worth typing. */
export function remainingSeconds(expiresAt: string, now = Date.now()): number {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return 0;
  return Math.max(0, Math.round((expiry - now) / 1000));
}

/** `4:32`, or nothing once it has expired. */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
