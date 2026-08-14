import { describe, expect, it } from 'vitest';

import { groupTurns, isActive, isTerminal, type ChatRun } from '../src/chat-model';

const run = (id: string, overrides: Partial<ChatRun> = {}): ChatRun =>
  ({
    run_id: id,
    node_id: 'node-1',
    project_id: 'project-1',
    node_run_id: `arun_${id}`,
    status: 'completed',
    request_metadata: {},
    created_by_user_id: 'owner',
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    terminal_reason: null,
    error_code: null,
    error_message: null,
    retry_of_run_id: null,
    last_event_seq: 0,
    session_id: 'session-1',
    submitted_input: `prompt ${id}`,
    ...overrides,
  }) as ChatRun;

describe('conversation grouping', () => {
  it('treats each submitted message as one turn', () => {
    const turns = groupTurns([run('a'), run('b')]);
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.primary.run_id)).toEqual(['a', 'b']);
    expect(turns.every((turn) => turn.attempts).valueOf()).toBe(true);
  });

  it('attaches a retry to the turn it repeats instead of adding a message', () => {
    const turns = groupTurns([run('a'), run('a-retry', { retry_of_run_id: 'a' })]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.primary.run_id).toBe('a');
    expect(turns[0]?.attempts.map((attempt) => attempt.run_id)).toEqual(['a', 'a-retry']);
  });

  it('keeps a retry of a retry in the original turn', () => {
    const turns = groupTurns([
      run('a'),
      run('a2', { retry_of_run_id: 'a' }),
      run('a3', { retry_of_run_id: 'a2' }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.attempts.map((attempt) => attempt.run_id)).toEqual(['a', 'a2', 'a3']);
  });

  it('shows an attempt whose original is outside the window rather than hiding it', () => {
    const turns = groupTurns([run('orphan', { retry_of_run_id: 'missing' })]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.primary.run_id).toBe('orphan');
  });

  it('classifies run states', () => {
    expect(isActive(run('x', { status: 'running' }))).toBe(true);
    expect(isActive(run('x', { status: 'waiting_for_approval' }))).toBe(true);
    expect(isTerminal(run('x', { status: 'completed' }))).toBe(true);
    expect(isTerminal(run('x', { status: 'interrupted' }))).toBe(true);
    expect(isTerminal(run('x', { status: 'running' }))).toBe(false);
  });
});
