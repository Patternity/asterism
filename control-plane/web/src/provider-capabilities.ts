/**
 * How a Node's reported provider support reads on a page.
 *
 * Kept apart from the component so the wording and, more importantly, the
 * refusals can be tested without rendering anything. Three of the four states
 * this handles are ways of *not* knowing, and each has to stay distinct:
 *
 * - **unknown** — the Node has never reported. A release older than the
 *   contract. Not "supports nothing", which would be a claim nobody made.
 * - **unsupported schema** — it reported a shape this console cannot read. The
 *   providers are deliberately unreachable from here: interpreting a shape you
 *   do not have is how an unknown version silently becomes a supported provider.
 * - **stale** — the Node is offline, so this describes the past.
 *
 * There is no provider list in this file either. Labels below are presentation
 * for tokens this console happens to recognise, with the raw token shown when it
 * does not; nothing here decides what a Node supports.
 */

export interface ReportedProvider {
  id: string;
  display_name: string;
  auth_methods: string[];
  availability: string;
  unavailable_reason?: string;
}

export type ProviderCapabilityView =
  | { state: 'unknown' }
  | {
      state: 'reported';
      status: 'ok' | 'unsupported_schema';
      schema_version: number;
      runtime_release: string | null;
      providers: ReportedProvider[] | null;
      reported_at: string | null;
      recorded_at: string;
      stale: boolean;
    };

/** What the panel should render, reduced to one decision. */
export type PanelState =
  | { kind: 'unknown' }
  | { kind: 'unsupported_schema'; schemaVersion: number }
  | { kind: 'providers'; providers: ReportedProvider[]; stale: boolean };

/**
 * Decide once, render from the result.
 *
 * A missing or malformed `providers` array under an `ok` status is treated as a
 * shape this console cannot read rather than as an empty catalogue — the same
 * refusal, for the same reason.
 */
export function panelState(view: ProviderCapabilityView | null | undefined): PanelState {
  if (!view || view.state === 'unknown') return { kind: 'unknown' };
  if (view.status !== 'ok' || !Array.isArray(view.providers)) {
    return { kind: 'unsupported_schema', schemaVersion: view.schema_version };
  }
  return { kind: 'providers', providers: view.providers, stale: view.stale };
}

/** Labels for tokens this console knows; the token itself for those it does not. */
const AUTH_METHOD_LABELS: Readonly<Record<string, string>> = {
  device_authorization: 'Browser approval',
  api_key: 'API key',
};

export function authMethodLabel(token: string): string {
  return AUTH_METHOD_LABELS[token] ?? token;
}

const UNAVAILABLE_REASONS: Readonly<Record<string, string>> = {
  runtime_missing: 'the runtime it needs is not installed',
};

/** One sentence for a provider that cannot be used here, or nothing. */
export function unavailableLabel(provider: ReportedProvider): string | null {
  if (provider.availability !== 'unavailable') return null;
  const reason = provider.unavailable_reason;
  const explained = reason ? UNAVAILABLE_REASONS[reason] : undefined;
  return explained ? `Unavailable — ${explained}` : 'Unavailable';
}

/** When the Node observed this, for a person. */
export function reportedAtLabel(view: ProviderCapabilityView): string | null {
  if (view.state !== 'reported') return null;
  const at = view.reported_at ?? view.recorded_at;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString();
}
