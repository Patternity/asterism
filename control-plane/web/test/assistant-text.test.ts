import { describe, expect, it } from 'vitest';

import { assistantText, reasoningEntries } from '../src/sse';
import type { RunEvent } from '../src/types';

const event = (seq: number, type: string, payload: Record<string, unknown>): RunEvent => ({
  run_id: 'run-1',
  seq,
  event_type: type,
  recorded_at: null,
  ingested_at: new Date().toISOString(),
  payload,
});

describe('assistant message assembly', () => {
  it('concatenates deltas in durable sequence order, not arrival order', () => {
    const text = assistantText([
      event(3, 'message.delta', { delta: 'world' }),
      event(1, 'message.delta', { delta: 'hello' }),
      event(2, 'message.delta', { delta: ' ' }),
    ]);
    expect(text).toBe('hello world');
  });

  it('preserves whitespace and line breaks verbatim', () => {
    const text = assistantText([
      event(1, 'message.delta', { delta: '# Heading\n\n' }),
      event(2, 'message.delta', { delta: '  indented line' }),
    ]);
    expect(text).toBe('# Heading\n\n  indented line');
  });

  it('prefers the canonical final output over the deltas, never both', () => {
    const text = assistantText([
      event(1, 'message.delta', { delta: 'partial' }),
      event(2, 'message.delta', { delta: ' text' }),
      event(3, 'run.completed', { output: 'partial text' }),
    ]);
    // Rendered once, not 'partial textpartial text'.
    expect(text).toBe('partial text');
  });

  it('falls back to deltas when the run carries no canonical output', () => {
    const text = assistantText([
      event(1, 'message.delta', { delta: 'streamed' }),
      event(2, 'run.completed', {}),
    ]);
    expect(text).toBe('streamed');
  });

  it('ignores unrelated events and malformed payloads', () => {
    const text = assistantText([
      event(1, 'tool.started', { name: 'read_file' }),
      event(2, 'message.delta', { delta: 'kept' }),
      event(3, 'message.delta', { delta: 42 }),
      event(4, 'reasoning.available', { text: 'hidden' }),
    ]);
    expect(text).toBe('kept');
  });

  it('accepts the historical payload field names as well as the live one', () => {
    // Live Hermes sends `delta`; the journal has carried the others.
    expect(assistantText([event(1, 'message.delta', { text: 'legacy' })])).toBe('legacy');
    expect(assistantText([event(1, 'message.delta', { content: 'other' })])).toBe('other');
    // The live field wins when more than one is present.
    expect(assistantText([event(1, 'message.delta', { delta: 'live', text: 'stale' })])).toBe(
      'live',
    );
  });

  it('returns empty text for a run that produced nothing yet', () => {
    expect(assistantText([])).toBe('');
    expect(assistantText([event(1, 'asterism.run.accepted', {})])).toBe('');
  });
});

describe("the agent's reasoning", () => {
  it('returns reasoning in durable sequence order, ignoring everything else', () => {
    expect(
      reasoningEntries([
        event(4, 'reasoning.available', { text: 'second thought' }),
        event(1, 'tool.started', { tool: 'terminal' }),
        event(2, 'reasoning.available', { text: 'first thought' }),
        event(3, 'message.delta', { delta: 'the answer' }),
      ]),
    ).toEqual([
      { seq: '2', text: 'first thought' },
      { seq: '4', text: 'second thought' },
    ]);
  });

  it('drops blank entries, which would render as an empty disclosure', () => {
    expect(
      reasoningEntries([
        event(1, 'reasoning.available', { text: '   ' }),
        event(2, 'reasoning.available', {}),
        event(3, 'reasoning.available', { text: 'kept' }),
      ]),
    ).toEqual([{ seq: '3', text: 'kept' }]);
  });
});
