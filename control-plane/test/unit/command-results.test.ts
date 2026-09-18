/**
 * What a console is told about a command it started.
 *
 * Two things are being protected here. A person must be able to read why an
 * action did not happen -- "that credential is still used by a project" -- and
 * nothing a Node wrote may reach the browser as it came, because a Node's
 * sentence can carry a path, a profile name or a provider's own phrasing.
 */
import { describe, expect, it } from 'vitest';

import { commandFailure, isTerminalCommandState } from '../../src/command-results.js';
import type { CommandRecord } from '../../src/repositories.js';

function command(overrides: Partial<CommandRecord> = {}): CommandRecord {
  return {
    organization_id: 'org_bootstrap',
    command_id: 'cmd-1',
    node_id: 'node-1',
    project_id: null,
    command_type: 'credentials.revoke',
    request_payload: {},
    payload_digest: 'digest',
    state: 'failed',
    created_at: new Date(),
    dispatched_at: new Date(),
    acknowledged_at: null,
    completed_at: new Date(),
    response_payload: null,
    error_code: 'command_failed',
    error_payload: null,
    dispatch_count: 1,
    correlation_id: null,
    idempotency_key: null,
    ...overrides,
  } as CommandRecord;
}

describe('a command is finished or it is not', () => {
  it('knows which states end one', () => {
    for (const state of ['completed', 'failed', 'rejected', 'indeterminate']) {
      expect(isTerminalCommandState(state)).toBe(true);
    }
    for (const state of ['pending', 'dispatched', 'acknowledged']) {
      expect(isTerminalCommandState(state)).toBe(false);
    }
  });

  it('says nothing about one still on its way, and nothing about one that worked', () => {
    expect(commandFailure(command({ state: 'dispatched' }))).toBeNull();
    expect(commandFailure(command({ state: 'completed', error_code: null }))).toBeNull();
  });
});

describe('a refusal is typed, and written here', () => {
  it('reads the innermost code a Node wrapped', () => {
    const failure = commandFailure(
      command({
        error_payload: {
          message:
            'credential_revoke_failed: credential_in_use: 1 project(s) use this credential; reassign them first',
        },
      }),
    );
    expect(failure?.code).toBe('credential_in_use');
    expect(failure?.message).toMatch(/still used by a project/);
    // The Node's own sentence is not what the browser is shown.
    expect(failure?.message).not.toContain('reassign them first');
  });

  it('never repeats what the provider runtime said', () => {
    const failure = commandFailure(
      command({
        error_payload: {
          message:
            'credential_revoke_failed: credential_runtime_missing: the provider runtime refused to remove the credential: No credential matching "Work account". Provider: openai-codex.',
        },
      }),
    );
    expect(failure?.code).toBe('credential_runtime_missing');
    expect(failure?.message).not.toContain('No credential matching');
    expect(failure?.message).not.toContain('Work account');
  });

  it('reads a login refused because one is already waiting', () => {
    const failure = commandFailure(
      command({
        command_type: 'credentials.authorize',
        error_payload: {
          message:
            'authorization_in_progress: another authorization is already waiting for a browser approval on this Node',
        },
      }),
    );
    expect(failure?.code).toBe('authorization_in_progress');
  });

  it('falls back to a general refusal for a code it has never seen', () => {
    const failure = commandFailure(
      command({
        error_payload: { message: 'invented_by_a_newer_node: /var/lib/asterism/node/secret.json' },
      }),
    );
    expect(failure?.code).toBe('command_failed');
    expect(failure?.message).toBe('The Node could not carry this out.');
    expect(failure?.message).not.toContain('/var/lib');
  });

  it('says what an answer that never arrived means', () => {
    const failure = commandFailure(
      command({ state: 'indeterminate', error_code: 'indeterminate', error_payload: null }),
    );
    expect(failure?.message).toMatch(/did not report whether/);
  });

  it('reads a Node that refused the frame outright', () => {
    const failure = commandFailure(
      command({
        state: 'rejected',
        error_code: 'forbidden_command',
        error_payload: { message: 'forbidden_command: node.update' },
      }),
    );
    expect(failure?.code).toBe('forbidden_command');
    expect(failure?.message).toMatch(/does not support that action/);
  });
});
