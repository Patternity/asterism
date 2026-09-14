import { describe, expect, it } from 'vitest';

import type { NodeCredential } from '../src/node-credentials';
import type { ProviderCapabilityView } from '../src/provider-capabilities';
import {
  SHARED_POOL,
  SHARED_POOL_LABEL,
  assignmentSummary,
  credentialChoices,
  credentialName,
  credentialPayload,
  defaultChoice,
} from '../src/project-credential';
import type { ProjectCredentialView } from '../src/types';

function capabilities(overrides: Record<string, unknown> = {}): ProviderCapabilityView {
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
    recorded_at: '2026-09-14T10:00:00.000Z',
    stale: false,
    ...overrides,
  } as ProviderCapabilityView;
}

function credential(overrides: Partial<NodeCredential> = {}): NodeCredential {
  return {
    credential_id: 'cred-work',
    provider_id: 'openai-codex',
    auth_method: 'device_authorization',
    label: 'Work account',
    state: 'authorized',
    storage: 'isolated',
    ...overrides,
  };
}

function view(overrides: Partial<ProjectCredentialView> = {}): ProjectCredentialView {
  return {
    mode: 'legacy_shared_pool',
    current: null,
    assignment: { state: 'applied', requested: null, failure: null },
    run_block: null,
    ...overrides,
  };
}

describe('what a project can be pointed at', () => {
  it('offers the shared pool as one thing and never its entries one by one', () => {
    const choices = credentialChoices(
      [
        credential({ credential_id: 'cred-pool-1', storage: 'legacy_shared_pool' }),
        // Reported by a Control Plane that predates storage: a pool entry.
        {
          credential_id: 'cred-pool-2',
          provider_id: 'openai-codex',
          auth_method: 'device_authorization',
          label: 'Existing credential',
          state: 'authorized',
        },
        credential(),
      ],
      capabilities(),
      true,
    );
    expect(choices.map((choice) => choice.value)).toEqual([SHARED_POOL, 'cred-work']);
    expect(choices[0]).toMatchObject({ label: SHARED_POOL_LABEL, disabled: false });
    expect(choices[1]).toMatchObject({ label: 'Work account (OpenAI Codex)', disabled: false });
  });

  it('shows what cannot be chosen, and why', () => {
    const choices = credentialChoices(
      [
        credential({ credential_id: 'cred-waiting', state: 'authorizing' }),
        credential({ credential_id: 'cred-other', provider_id: 'acme-llm' }),
        credential({ credential_id: 'cred-gone', state: 'revoked' }),
      ],
      capabilities(),
      false,
    );
    expect(choices).toEqual([
      expect.objectContaining({ value: SHARED_POOL, disabled: true }),
      expect.objectContaining({ value: 'cred-waiting', reason: 'needs authorization' }),
      expect.objectContaining({ value: 'cred-other', reason: 'provider unavailable on this Node' }),
    ]);
    expect(credentialChoices([credential()], capabilities({ stale: true }), true)[1]?.reason).toBe(
      'Node is not connected',
    );
  });

  /** Two credentials with one label are still two choices, told apart by id. */
  it('keeps two credentials with the same label apart', () => {
    const choices = credentialChoices(
      [credential({ credential_id: 'cred-a' }), credential({ credential_id: 'cred-b' })],
      capabilities(),
      true,
    );
    expect(new Set(choices.map((choice) => choice.value)).size).toBe(3);
  });

  it('starts on the shared pool when it works, and on a working credential when not', () => {
    expect(defaultChoice(credentialChoices([credential()], capabilities(), true))).toBe(
      SHARED_POOL,
    );
    expect(defaultChoice(credentialChoices([credential()], capabilities(), false))).toBe(
      'cred-work',
    );
    expect(defaultChoice(credentialChoices([], capabilities(), false))).toBe(SHARED_POOL);
  });

  it('sends the shared pool as null and a credential as its id', () => {
    expect(credentialPayload(SHARED_POOL)).toBeNull();
    expect(credentialPayload('cred-work')).toBe('cred-work');
  });
});

describe('how a project states its credential', () => {
  it('names a credential by label and provider', () => {
    expect(
      credentialName(
        {
          credential_id: 'cred-work',
          label: 'Work account',
          provider_id: 'openai-codex',
          state: 'authorized',
        },
        capabilities(),
      ),
    ).toBe('Work account (OpenAI Codex)');
    expect(credentialName(null)).toBe(SHARED_POOL_LABEL);
  });

  it('says nothing when nothing is changing', () => {
    expect(assignmentSummary(view())).toBeNull();
  });

  it('describes a change in flight, one that failed, and one that left things unknown', () => {
    const requested = {
      mode: 'isolated' as const,
      credential: {
        credential_id: 'cred-work',
        label: 'Work account',
        provider_id: 'openai-codex',
        state: 'authorized',
      },
    };
    expect(
      assignmentSummary(view({ assignment: { state: 'pending', requested, failure: null } })),
    ).toMatch(/^Switching to Work account/);
    const failed = assignmentSummary(
      view({ assignment: { state: 'failed', requested, failure: 'worker_unhealthy' } }),
    );
    expect(failed).toMatch(/did not come up on that credential/);
    expect(failed).toMatch(/still uses Shared credential pool/);
    expect(
      assignmentSummary(
        view({ assignment: { state: 'inconsistent', requested, failure: 'something_new' } }),
      ),
    ).toMatch(/could not confirm/);
  });
});
