import { useEffect, useState } from 'react';

/**
 * Watching a Node install itself.
 *
 * The stage names arrive from the Control Plane as typed values and are turned
 * into sentences here, in one place. Matching English anywhere else would mean a
 * reworded message silently stops being recognised; matching it here means a
 * stage this build has never heard of still renders as itself rather than as
 * nothing.
 */

export interface InstallationProgress {
  seq: number;
  generation: number;
  state: string;
  percent: number;
  bytes_done: number | null;
  bytes_total: number | null;
  failure_code: string | null;
  recorded_at: string;
}

export interface InstallationRecord {
  installation_id: string;
  display_name: string;
  state: string;
  generation: number;
  percent: number;
  bytes_done: number | null;
  bytes_total: number | null;
  failure_code: string | null;
  retryable: boolean;
  node_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

/** What each stage means, said as the thing that is happening now. */
const STAGE_LABELS: Record<string, string> = {
  code_issued: 'Waiting for the server to run the command',
  bootstrap_downloaded: 'The server has the installer',
  bundle_metadata_fetched: 'Checking what this release contains',
  bundle_downloading: 'Downloading the runtime',
  bundle_verified: 'Runtime verified',
  plan_prepared: 'Ready to install',
  prerequisites_installing: 'Installing prerequisites',
  runtime_installing: 'Installing the runtime',
  configuration_writing: 'Writing configuration',
  identity_enrolling: 'Enrolling this Node',
  services_starting: 'Starting services',
  node_connecting: 'Connecting to Asterism',
  health_verifying: 'Checking it is healthy',
  complete: 'Online',
  failed: 'Installation failed',
  cancelled: 'Cancelled',
  expired: 'The code expired before the server used it',
};

export function stageLabel(state: string): string {
  // An unknown stage renders as itself rather than as a blank line: a console
  // that silently omits what it does not recognise is worse than one that says
  // something plain.
  return STAGE_LABELS[state] ?? state.replace(/_/g, ' ');
}

const TERMINAL_STATES = new Set(['complete', 'failed', 'cancelled', 'expired']);

export function isTerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Why an installation stopped, in terms of what the person can do about it.
 *
 * Retryability comes from the Control Plane rather than from this list, so a
 * code this build has not seen is still offered the right action.
 */
const FAILURE_EXPLANATIONS: Record<string, string> = {
  unsupported_os: 'This server’s operating system is not one Asterism supports.',
  unsupported_architecture: 'This server’s processor architecture has no Asterism runtime.',
  insufficient_disk: 'This server does not have enough free disk space for the runtime.',
  download_failed: 'The runtime could not be downloaded from this server.',
  digest_mismatch: 'The downloaded runtime did not match its published checksum and was refused.',
  signature_invalid: 'The downloaded runtime’s signature could not be verified.',
  unsupported_bundle_schema: 'This release is newer than the installer that was run.',
  prerequisites_failed: 'A prerequisite could not be installed on this server.',
  runtime_install_failed: 'The runtime could not be installed on this server.',
  enrollment_rejected: 'Asterism refused this connection code. It may have expired or been used.',
  service_start_failed: 'The services were installed but did not start.',
  health_check_failed: 'The Node started but did not report itself healthy.',
  interrupted: 'The installation was interrupted before it finished.',
  internal_error: 'Something went wrong during the installation.',
};

export function failureExplanation(code: string | null): string {
  if (!code) return 'The installation stopped before it finished.';
  return FAILURE_EXPLANATIONS[code] ?? `The installation stopped: ${code.replace(/_/g, ' ')}.`;
}

/**
 * Bytes as a person reads them.
 *
 * Decimal units, because that is what a download is measured in everywhere else
 * a person will compare this against.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The download line, when there is one to show. */
export function downloadDetail(record: {
  state: string;
  bytes_done: number | null;
  bytes_total: number | null;
}): string {
  if (record.state !== 'bundle_downloading') return '';
  if (record.bytes_done === null) return '';
  if (record.bytes_total === null || record.bytes_total <= 0) {
    return formatBytes(record.bytes_done);
  }
  return `${formatBytes(record.bytes_done)} of ${formatBytes(record.bytes_total)}`;
}

/**
 * The command a person runs on their server.
 *
 * The connection code is deliberately not in it. A command carrying a
 * credential ends up in shell history, in a screenshot, and in whatever the
 * person pasted it through; the installer prompts for the code instead, with
 * the terminal's echo off.
 */
export function bootstrapCommand(controlPlaneOrigin: string, repo = 'Patternity/asterism'): string {
  return (
    `curl -fsSL https://raw.githubusercontent.com/${repo}/master/scripts/bootstrap.sh | ` +
    `sudo ASTERISM_CONTROL_PLANE=${controlPlaneOrigin} sh`
  );
}

export function cursorStorageKey(installationId: string): string {
  return `asterism:installation:${installationId}`;
}

export type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'complete' | 'closed';

/**
 * Follow one installation's progress.
 *
 * The same resume mechanism run events use: the browser remembers the last
 * sequence it saw, so a reload picks up where it left off instead of replaying
 * a download from zero. The stream ends deliberately when the installation
 * reaches a terminal state, and that ending is not treated as a dropped
 * connection — reconnecting then would retry forever against a finished install.
 */
export function useInstallationProgress(installationId: string) {
  const [latest, setLatest] = useState<InstallationProgress | undefined>();
  const [state, setState] = useState<StreamState>('connecting');

  // Resetting during render is React's documented way to clear state when the
  // subject changes; doing it inside the effect would cascade an extra render.
  const [subject, setSubject] = useState(installationId);
  if (subject !== installationId) {
    setSubject(installationId);
    setLatest(undefined);
    setState('connecting');
  }

  useEffect(() => {
    if (!installationId) return;
    const key = cursorStorageKey(installationId);
    let source: EventSource | undefined;
    let retry: number | undefined;
    let stopped = false;
    let sawTerminal = false;

    const connect = () => {
      const cursor = Number(sessionStorage.getItem(key) ?? 0);
      source = new EventSource(
        `/api/v1/node-installations/${encodeURIComponent(installationId)}/events/stream?since_seq=${cursor}`,
        { withCredentials: true },
      );
      source.onopen = () => {
        if (!sawTerminal) setState('connected');
      };
      source.addEventListener('installation.progress', ((message: MessageEvent<string>) => {
        const event = JSON.parse(message.data) as InstallationProgress;
        sessionStorage.setItem(key, String(event.seq));
        // Only ever moves forward. An out-of-order arrival must not walk the bar
        // backwards on screen.
        setLatest((current) => (current && current.seq >= event.seq ? current : event));
        if (isTerminalState(event.state)) {
          sawTerminal = true;
          source?.close();
          if (retry !== undefined) window.clearTimeout(retry);
          setState('complete');
        }
      }) as EventListener);
      source.onerror = () => {
        source?.close();
        if (sawTerminal) {
          setState('complete');
          return;
        }
        if (!stopped) {
          setState('reconnecting');
          retry = window.setTimeout(connect, 1_000);
        }
      };
    };

    connect();
    return () => {
      stopped = true;
      source?.close();
      if (retry !== undefined) window.clearTimeout(retry);
      setState('closed');
    };
  }, [installationId]);

  return { latest, state };
}
