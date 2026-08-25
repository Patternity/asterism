import { describe, expect, it } from 'vitest';

import { describeToolUse, summarizeToolActivity } from '../src/tool-activity';
import type { RunEvent } from '../src/types';

let seq = 0;
function event(event_type: string, payload: Record<string, unknown> = {}): RunEvent {
  seq += 1;
  return { seq, event_type, payload, recorded_at: null, ingested_at: null } as unknown as RunEvent;
}

describe('tool activity summary', () => {
  it('names the tool the runtime reported, not the event type', () => {
    const summary = summarizeToolActivity([
      event('tool.started', { tool: 'read_file' }),
      event('tool.completed', { tool: 'read_file', error: false }),
    ]);
    expect(summary).toEqual([{ tool: 'read_file', count: 1, failures: 0, running: false }]);
  });

  it('collapses repeated invocations into one entry with a count', () => {
    const events = [];
    for (let index = 0; index < 9; index += 1) {
      events.push(event('tool.started', { tool: 'read_file' }));
    }
    for (let index = 0; index < 9; index += 1) {
      events.push(event('tool.completed', { tool: 'read_file', error: false }));
    }
    const summary = summarizeToolActivity(events);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ tool: 'read_file', count: 9, running: false });
    expect(describeToolUse(summary[0]!)).toBe('read_file ×9');
  });

  it('keeps tools in the order they first ran', () => {
    const summary = summarizeToolActivity([
      event('tool.started', { tool: 'skill_view' }),
      event('tool.completed', { tool: 'skill_view' }),
      event('tool.started', { tool: 'terminal' }),
      event('tool.completed', { tool: 'terminal' }),
      event('tool.started', { tool: 'skill_view' }),
      event('tool.completed', { tool: 'skill_view' }),
    ]);
    expect(summary.map((use) => use.tool)).toEqual(['skill_view', 'terminal']);
    expect(summary[0]!.count).toBe(2);
  });

  it('marks a tool as running while a start has no completion', () => {
    const summary = summarizeToolActivity([
      event('tool.started', { tool: 'terminal' }),
      event('tool.started', { tool: 'read_file' }),
      event('tool.completed', { tool: 'read_file' }),
    ]);
    expect(summary.find((use) => use.tool === 'terminal')!.running).toBe(true);
    expect(summary.find((use) => use.tool === 'read_file')!.running).toBe(false);
  });

  it('reports how many invocations errored, not merely that one did', () => {
    const summary = summarizeToolActivity([
      event('tool.started', { tool: 'terminal' }),
      event('tool.completed', { tool: 'terminal', error: false }),
      event('tool.started', { tool: 'terminal' }),
      event('tool.completed', { tool: 'terminal', error: true }),
    ]);
    expect(summary[0]).toMatchObject({ count: 2, failures: 1 });
    expect(describeToolUse(summary[0]!)).toBe('terminal ×2 (1 failed)');
  });

  it('counts an unnamed tool rather than dropping it', () => {
    const summary = summarizeToolActivity([
      event('tool.started', {}),
      event('tool.completed', { tool: '   ' }),
    ]);
    expect(summary).toEqual([{ tool: 'unnamed tool', count: 1, failures: 0, running: false }]);
  });

  it('counts a completion whose start is missing from a truncated journal', () => {
    const summary = summarizeToolActivity([event('tool.completed', { tool: 'read_file' })]);
    expect(summary[0]).toMatchObject({ tool: 'read_file', count: 1, running: false });
  });

  it('ignores everything that is not a tool event', () => {
    expect(
      summarizeToolActivity([
        event('message.delta', { delta: 'hello' }),
        event('reasoning.available', { text: 'a trailing restatement of the answer' }),
        event('approval.request', { tool: 'terminal' }),
      ]),
    ).toEqual([]);
  });
});

describe('how many failed', () => {
  const events = (entries: { type: string; tool: string; error?: boolean }[]) =>
    entries.map((entry, index) => ({
      run_id: 'run-1',
      seq: index + 1,
      event_type: entry.type,
      recorded_at: null,
      ingested_at: '2026-01-01T00:00:00Z',
      payload: { tool: entry.tool, ...(entry.error === undefined ? {} : { error: entry.error }) },
    })) as unknown as Parameters<typeof summarizeToolActivity>[0];

  it('counts failures rather than flagging them', () => {
    const summary = summarizeToolActivity(
      events([
        { type: 'tool.started', tool: 'terminal' },
        { type: 'tool.started', tool: 'terminal' },
        { type: 'tool.started', tool: 'terminal' },
        { type: 'tool.completed', tool: 'terminal', error: true },
        { type: 'tool.completed', tool: 'terminal', error: false },
        { type: 'tool.completed', tool: 'terminal', error: false },
      ]),
    );
    expect(summary[0]!.failures).toBe(1);
    // A run that recovered reads differently from one that did not.
    expect(describeToolUse(summary[0]!)).toBe('terminal ×3 (1 failed)');
  });

  it('says plainly when everything failed', () => {
    const summary = summarizeToolActivity(
      events([
        { type: 'tool.started', tool: 'terminal' },
        { type: 'tool.started', tool: 'terminal' },
        { type: 'tool.completed', tool: 'terminal', error: true },
        { type: 'tool.completed', tool: 'terminal', error: true },
      ]),
    );
    expect(describeToolUse(summary[0]!)).toBe('terminal ×2 (failed)');
  });

  it('reports nothing when nothing failed', () => {
    const summary = summarizeToolActivity(
      events([
        { type: 'tool.started', tool: 'read_file' },
        { type: 'tool.completed', tool: 'read_file', error: false },
      ]),
    );
    expect(summary[0]!.failures).toBe(0);
    expect(describeToolUse(summary[0]!)).toBe('read_file');
  });
});
