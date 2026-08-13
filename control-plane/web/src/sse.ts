import { useEffect, useMemo, useState } from 'react';

import type { RunEvent } from './types';

const EVENT_TYPES = [
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.completed',
  'reasoning.available',
  'approval.request',
  'run.completed',
  'run.failed',
  'asterism.run.accepted',
  'asterism.run.submitted',
  'asterism.run.terminal',
  'asterism.reconciled',
];

export function cursorStorageKey(organizationId: string, runId: string): string {
  return `asterism:sse:${organizationId}:${runId}`;
}

export function useRunEvents(organizationId: string, runId: string) {
  const key = useMemo(() => cursorStorageKey(organizationId, runId), [organizationId, runId]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<'connecting' | 'connected' | 'reconnecting' | 'closed'>(
    'connecting',
  );

  useEffect(() => {
    let source: EventSource | undefined;
    let retry: number | undefined;
    let stopped = false;
    const connect = () => {
      const cursor = Number(sessionStorage.getItem(key) ?? 0);
      source = new EventSource(
        `/api/v1/runs/${encodeURIComponent(runId)}/events/stream?since_seq=${cursor}`,
        { withCredentials: true },
      );
      source.onopen = () => setState('connected');
      const receive = (message: MessageEvent<string>) => {
        const event = JSON.parse(message.data) as RunEvent;
        sessionStorage.setItem(key, String(event.seq));
        setEvents((current) =>
          current.some((item) => Number(item.seq) === Number(event.seq))
            ? current
            : [...current, event].sort((a, b) => Number(a.seq) - Number(b.seq)),
        );
      };
      for (const type of EVENT_TYPES) source.addEventListener(type, receive as EventListener);
      source.onerror = () => {
        source?.close();
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
