import { useEffect, useMemo, useState } from 'react';

import type { RunEvent } from './types';

/**
 * Every event type the live stream subscribes to.
 *
 * `EventSource` delivers named events only to listeners registered for that
 * name, so a type missing here never reaches the browser at all while a run is
 * live — it appears only after a reload, from the archive. That asymmetry is
 * how a run could stream an approval request but never the answer to it: the
 * prompt stayed on screen because the resolution was, from the browser's point
 * of view, never sent.
 *
 * So this list has to cover everything the console reasons about, not just
 * everything it displays. `conformance.test.ts` checks that it does.
 */
export const EVENT_TYPES = [
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.completed',
  'reasoning.available',
  'approval.request',
  // How an approval ends: answered by an operator, by the run's own policy, or
  // confirmed by the runtime. Without these the prompt cannot clear itself.
  'approval.responded',
  'approval.auto_resolved',
  'asterism.approval.decision',
  // The run-scoped approval policy, which decides whether a prompt is even the
  // operator's to answer.
  'run.approval_policy.changed',
  'run.completed',
  'run.failed',
  'asterism.run.accepted',
  'asterism.run.submitted',
  'asterism.run.terminal',
  'asterism.reconciled',
];

/**
 * The Node's terminal marker. Its arrival means the journal for this run is
 * finished: no further event will ever be appended, so the server closes the
 * stream on purpose.
 */
export const TERMINAL_EVENT_TYPE = 'asterism.run.terminal';

export type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'complete' | 'closed';

export function cursorStorageKey(organizationId: string, runId: string): string {
  return `asterism:sse:${organizationId}:${runId}`;
}

/**
 * Subscribe to one run's durable event journal.
 *
 * Two endings must not be confused. A **terminal event** means the run is over
 * and the server hangs up deliberately; reconnecting then would loop forever and
 * show `reconnecting` on a run that finished minutes ago. A **network failure**
 * means the journal continues and the client must resume from its cursor.
 *
 * `EventSource` reports both as `onerror`, so the terminal event is recorded as
 * it arrives and consulted before deciding to retry.
 */
export function useRunEvents(organizationId: string, runId: string) {
  const key = useMemo(() => cursorStorageKey(organizationId, runId), [organizationId, runId]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<StreamState>('connecting');

  // Resetting during render is React's documented way to clear state when the
  // subject changes; doing it inside the effect would cascade an extra render.
  const [subject, setSubject] = useState(runId);
  if (subject !== runId) {
    setSubject(runId);
    setEvents([]);
    setState('connecting');
  }

  useEffect(() => {
    let source: EventSource | undefined;
    let retry: number | undefined;
    let stopped = false;
    // Set from the event handler and read by `onerror`, which fires afterwards.
    let sawTerminal = false;

    const connect = () => {
      // Replay resumes from the highest sequence this browser already stored, so
      // a reconnect never re-renders text the reader has already seen.
      const cursor = Number(sessionStorage.getItem(key) ?? 0);
      source = new EventSource(
        `/api/v1/runs/${encodeURIComponent(runId)}/events/stream?since_seq=${cursor}`,
        { withCredentials: true },
      );
      source.onopen = () => {
        if (!sawTerminal) setState('connected');
      };
      const receive = (message: MessageEvent<string>) => {
        const event = JSON.parse(message.data) as RunEvent;
        sessionStorage.setItem(key, String(event.seq));
        if (event.event_type === TERMINAL_EVENT_TYPE) sawTerminal = true;
        setEvents((current) =>
          current.some((item) => Number(item.seq) === Number(event.seq))
            ? current
            : [...current, event].sort((a, b) => Number(a.seq) - Number(b.seq)),
        );
        if (sawTerminal) {
          // Close before the server does, so the shutdown is never mistaken for
          // a dropped connection.
          source?.close();
          if (retry !== undefined) window.clearTimeout(retry);
          setState('complete');
        }
      };
      for (const type of EVENT_TYPES) source.addEventListener(type, receive as EventListener);
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
  }, [key, runId]);

  return { events, state };
}

/**
 * Assemble one assistant message from its journal.
 *
 * Deltas are concatenated in `seq` order — the durable sequence, not arrival
 * order — so replay after a reload produces exactly the same text. Whitespace is
 * preserved verbatim because the model's line breaks are part of the answer.
 *
 * When the run finished, `run.completed` carries the canonical output. It is
 * preferred over the concatenation rather than appended to it, which is what
 * keeps a completed answer from rendering twice.
 */
export function assistantText(events: RunEvent[]): string {
  const completed = [...events]
    .reverse()
    .find(
      (event) => event.event_type === 'run.completed' && typeof event.payload.output === 'string',
    );
  if (completed) return completed.payload.output as string;

  return [...events]
    .filter((event) => event.event_type === 'message.delta')
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .map(deltaText)
    .join('');
}

/**
 * Read the text out of one delta.
 *
 * Hermes sends `delta`, which is what live runs actually carry. The other names
 * are accepted because the journal has historically contained them and dropping
 * a fragment silently would corrupt the message rather than fail loudly.
 */
function deltaText(event: RunEvent): string {
  for (const key of ['delta', 'text', 'content', 'message']) {
    const value = event.payload[key];
    if (typeof value === 'string') return value;
  }
  return '';
}
