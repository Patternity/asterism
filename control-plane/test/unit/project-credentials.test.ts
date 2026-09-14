import { describe, expect, it } from 'vitest';

import type { CredentialRow } from '../../src/node-credentials-repository.js';
import type { CapabilityView } from '../../src/provider-capabilities-repository.js';
import {
  ASSIGNMENT_FAILURES,
  credentialAssignPayload,
  credentialView,
  knownAssignmentFailure,
  runCredentialBlock,
  selectionRefusal,
  type ProjectCredentialFields,
} from '../../src/project-credentials.js';

function credential(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    node_id: 'node-1',
    credential_id: 'cred-isolated',
    provider_id: 'openai-codex',
    auth_method: 'device_authorization',
    label: 'Work account',
    state: 'authorized',
    storage: 'isolated',
    created_at: null,
    updated_at: null,
    recorded_at: new Date(0),
    ...overrides,
  };
}

function capabilities(overrides: Record<string, unknown> = {}): CapabilityView {
  return {
    state: 'reported',
    status: 'ok',
    schema_version: 1,
    runtime_release: 'v0.1.0-alpha.27',
    providers: [
      {
        id: 'openai-codex',
        display_name: 'OpenAI Codex',
        auth_methods: ['device_authorization'],
        availability: 'available',
      },
    ],
    reported_at: null,
    recorded_at: new Date(0).toISOString(),
    stale: false,
    ...overrides,
  } as CapabilityView;
}

function project(overrides: Partial<ProjectCredentialFields> = {}): ProjectCredentialFields {
  return {
    project_id: 'prj_1',
    node_project_id: 'prj_1',
    credential_id: null,
    requested_credential_id: null,
    credential_assignment_state: 'applied',
    credential_assignment_generation: 0,
    credential_assignment_failure: null,
    ...overrides,
  };
}

describe('what a project may select', () => {
  it('accepts an authorized isolated credential on an available provider', () => {
    expect(selectionRefusal(credential(), capabilities(), true)).toBeNull();
  });

  /**
   * A foreign credential never reaches this function as anything but `null`,
   * because it is looked up by the project's own Node. The answer is the same
   * as for one that never existed, so nothing is disclosed.
   */
  it('refuses a credential its Node does not report exactly like a foreign one', () => {
    expect(selectionRefusal(null, capabilities(), true)).toMatchObject({
      status: 404,
      error: 'credential_not_found',
    });
  });

  it('never offers an entry of the shared pool as an exact selection', () => {
    expect(
      selectionRefusal(credential({ storage: 'legacy_shared_pool' }), capabilities(), true),
    ).toMatchObject({ status: 409, error: 'credential_not_selectable' });
  });

  it('refuses every state but authorized', () => {
    for (const state of ['required', 'authorizing', 'failed', 'revoked']) {
      expect(selectionRefusal(credential({ state }), capabilities(), true)?.error).toBe(
        'credential_not_authorized',
      );
    }
  });

  it('refuses when the Node cannot confirm it', () => {
    expect(selectionRefusal(credential(), capabilities(), false)?.error).toBe('node_offline');
    expect(selectionRefusal(credential(), { state: 'unknown' }, true)?.error).toBe(
      'capabilities_unknown',
    );
    expect(
      selectionRefusal(
        credential(),
        capabilities({ status: 'unsupported_schema', providers: null }),
        true,
      )?.error,
    ).toBe('capabilities_unknown');
    expect(selectionRefusal(credential(), capabilities({ stale: true }), true)?.error).toBe(
      'capabilities_stale',
    );
  });

  it('refuses a provider the Node does not report as available', () => {
    const unavailable = capabilities({
      providers: [
        {
          id: 'openai-codex',
          display_name: 'OpenAI Codex',
          auth_methods: ['device_authorization'],
          availability: 'unavailable',
        },
      ],
    });
    expect(selectionRefusal(credential(), unavailable, true)?.error).toBe(
      'credential_provider_unavailable',
    );
    expect(
      selectionRefusal(credential({ provider_id: 'acme-llm' }), capabilities(), true)?.error,
    ).toBe('credential_provider_unavailable');
  });
});

describe('when a run is refused for its credential', () => {
  /** The legacy path is judged by the provider state, exactly as before. */
  it('says nothing about a project on the shared pool', () => {
    expect(runCredentialBlock(project(), [], { state: 'unknown' })).toBeNull();
    expect(
      runCredentialBlock(project({ credential_assignment_state: 'failed' }), [], capabilities()),
    ).toBeNull();
  });

  it('allows a project on a usable isolated credential', () => {
    expect(
      runCredentialBlock(
        project({ credential_id: 'cred-isolated' }),
        [credential()],
        capabilities(),
      ),
    ).toBeNull();
  });

  it('names every reason a run cannot start', () => {
    const assigned = project({ credential_id: 'cred-isolated' });
    const cases: [ProjectCredentialFields, CredentialRow[], CapabilityView, string][] = [
      [
        project({ credential_assignment_state: 'pending' }),
        [credential()],
        capabilities(),
        'credential_assignment_pending',
      ],
      [
        project({ credential_assignment_state: 'inconsistent' }),
        [credential()],
        capabilities(),
        'credential_assignment_inconsistent',
      ],
      [assigned, [], capabilities(), 'credential_missing'],
      [
        assigned,
        [credential({ storage: 'legacy_shared_pool' })],
        capabilities(),
        'credential_inconsistent',
      ],
      [assigned, [credential({ state: 'required' })], capabilities(), 'credential_not_authorized'],
      [assigned, [credential()], { state: 'unknown' }, 'credential_capabilities_unknown'],
      [assigned, [credential()], capabilities({ stale: true }), 'credential_capabilities_stale'],
      [
        assigned,
        [credential({ provider_id: 'acme-llm' })],
        capabilities(),
        'credential_provider_unavailable',
      ],
    ];
    for (const [fields, rows, view, expected] of cases) {
      const block = runCredentialBlock(fields, rows, view);
      expect(block?.error, expected).toBe(expected);
      expect(block?.message.length).toBeGreaterThan(0);
    }
  });

  /** A credential of another Node is not in this Node's list, so it is missing. */
  it('treats a credential reported only by another Node as missing', () => {
    const block = runCredentialBlock(
      project({ credential_id: 'cred-isolated' }),
      [credential({ credential_id: 'cred-elsewhere' })],
      capabilities(),
    );
    expect(block?.error).toBe('credential_missing');
  });
});

describe('what a project page is told', () => {
  it('names the credential by label and provider and nothing that locates it', () => {
    const view = credentialView(
      project({ credential_id: 'cred-isolated' }),
      [credential()],
      capabilities(),
    );
    expect(view).toMatchObject({
      mode: 'isolated',
      current: { label: 'Work account', provider_id: 'openai-codex' },
      assignment: { state: 'applied', requested: null },
      run_block: null,
    });
    const serialized = JSON.stringify(view);
    for (const forbidden of ['/var/lib', 'auth.json', 'pool_entry', 'token', 'home']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('says honestly that a legacy project reads the shared pool', () => {
    expect(credentialView(project(), [credential()], capabilities())).toMatchObject({
      mode: 'legacy_shared_pool',
      current: null,
    });
  });

  it('shows a failed change beside the assignment still in force', () => {
    const view = credentialView(
      project({
        credential_assignment_state: 'failed',
        requested_credential_id: 'cred-isolated',
        credential_assignment_failure: 'worker_unhealthy',
      }),
      [credential()],
      capabilities(),
    );
    expect(view.mode).toBe('legacy_shared_pool');
    expect(view.assignment).toMatchObject({
      state: 'failed',
      failure: 'worker_unhealthy',
      requested: { mode: 'isolated', credential: { label: 'Work account' } },
    });
  });
});

describe('the command that applies an assignment', () => {
  it('sends a request for the shared pool as an explicit null', () => {
    const payload = credentialAssignPayload(
      project({ credential_assignment_generation: 3, requested_credential_id: null }),
    );
    expect(payload).toEqual({
      version: 1,
      project_id: 'prj_1',
      node_project_id: 'prj_1',
      assignment_generation: 3,
      credential_id: null,
    });
    expect(JSON.parse(JSON.stringify(payload))).toHaveProperty('credential_id', null);
  });

  it('keeps an unknown failure code out of durable state', () => {
    for (const code of ASSIGNMENT_FAILURES) expect(knownAssignmentFailure(code)).toBe(code);
    for (const code of ['something_new', '', 7, null]) {
      expect(knownAssignmentFailure(code)).toBeNull();
    }
  });
});
