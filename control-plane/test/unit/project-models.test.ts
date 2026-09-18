/**
 * What may be chosen as a project's model, decided without a model list.
 *
 * Every case here is a refusal or an acceptance derived from one Node's own
 * report. The identifiers in this file are arbitrary on purpose: if any of
 * these tests could be made to pass by adding a name to a table in `src/`, the
 * architecture would already be broken.
 */
import { describe, expect, it } from 'vitest';

import type { CapabilityView } from '../../src/provider-capabilities-repository.js';
import {
  MODEL_SELECT_COMMAND,
  MODEL_SELECT_COMMAND_VERSION,
  knownModelFailure,
  modelSelectPayload,
  modelSelectionRefusal,
  modelView,
  runModelBlock,
  validateModelId,
  type ProjectModelFields,
} from '../../src/project-models.js';

const MODELS = [
  { id: 'quokka-9.2:fast', display_name: 'Quokka 9.2 Fast' },
  { id: 'quokka-9.2', display_name: 'Quokka 9.2' },
];

function capabilities(overrides: Partial<Extract<CapabilityView, { state: 'reported' }>> = {}) {
  return {
    state: 'reported',
    status: 'ok',
    schema_version: 2,
    runtime_release: 'v0.1.0-alpha.32',
    providers: [
      {
        id: 'acme-llm',
        display_name: 'ACME',
        auth_methods: ['device_authorization'],
        availability: 'available',
        models: MODELS,
      },
      {
        id: 'other-llm',
        display_name: 'Other',
        auth_methods: ['device_authorization'],
        availability: 'available',
        models: [{ id: 'other-1', display_name: 'Other One' }],
      },
    ],
    reported_at: new Date().toISOString(),
    recorded_at: new Date().toISOString(),
    stale: false,
    ...overrides,
  } as CapabilityView;
}

function project(overrides: Partial<ProjectModelFields> = {}): ProjectModelFields {
  return {
    project_id: 'prj_1',
    node_project_id: 'np_1',
    credential_id: 'cred-work',
    model: null,
    requested_model: null,
    model_selection_state: 'legacy_default',
    model_selection_generation: 0,
    model_selection_failure: null,
    ...overrides,
  };
}

describe('an identifier is judged by its shape, never by a list', () => {
  it('accepts anything a runtime could plausibly call a model', () => {
    for (const good of ['gpt-5.6-sol', 'quokka-9.2:fast', 'Some_Model-7', 'a']) {
      expect(validateModelId(good)).toBe(good);
    }
    expect(validateModelId('  gpt-5.5  ')).toBe('gpt-5.5');
  });

  it('refuses anything that could mean something else where it is written', () => {
    for (const bad of [
      '',
      '   ',
      '../../etc/passwd',
      'a b',
      'a/b',
      'model\nmodel',
      'x'.repeat(65),
      42,
      null,
      { id: 'gpt-5.5' },
    ]) {
      expect(validateModelId(bad)).toBeNull();
    }
  });
});

describe('what may be chosen', () => {
  it('accepts a model the Node reported for that credential’s provider', () => {
    expect(modelSelectionRefusal('acme-llm', 'quokka-9.2:fast', capabilities(), true)).toBeNull();
  });

  it('refuses a model the Node reported for another provider', () => {
    const refusal = modelSelectionRefusal('acme-llm', 'other-1', capabilities(), true);
    expect(refusal).toMatchObject({ status: 409, error: 'model_not_reported' });
  });

  it('refuses a project that runs on no credential of its own', () => {
    expect(modelSelectionRefusal(null, 'quokka-9.2', capabilities(), true)).toMatchObject({
      error: 'credential_not_assigned',
    });
  });

  it('refuses an offline Node before it looks at anything else', () => {
    expect(modelSelectionRefusal('acme-llm', 'quokka-9.2', capabilities(), false)).toMatchObject({
      error: 'node_offline',
    });
  });

  /** Three states that are not each other, and are not an empty list either. */
  it('tells stale, unknown and unsupported apart', () => {
    expect(
      modelSelectionRefusal('acme-llm', 'quokka-9.2', capabilities({ stale: true }), true),
    ).toMatchObject({ error: 'capabilities_stale' });
    expect(
      modelSelectionRefusal('acme-llm', 'quokka-9.2', { state: 'unknown' }, true),
    ).toMatchObject({ error: 'capabilities_unknown' });
    expect(
      modelSelectionRefusal(
        'acme-llm',
        'quokka-9.2',
        capabilities({ status: 'unsupported_schema', schema_version: 99, providers: null }),
        true,
      ),
    ).toMatchObject({ error: 'capabilities_unsupported' });
    expect(
      modelSelectionRefusal(
        'acme-llm',
        'quokka-9.2',
        capabilities({
          providers: [
            {
              id: 'acme-llm',
              display_name: 'ACME',
              auth_methods: ['device_authorization'],
              availability: 'available',
              models: [],
            },
          ],
        }),
        true,
      ),
    ).toMatchObject({ error: 'model_selection_unavailable' });
  });

  it('refuses a provider the Node cannot currently reach', () => {
    expect(
      modelSelectionRefusal(
        'acme-llm',
        'quokka-9.2',
        capabilities({
          providers: [
            {
              id: 'acme-llm',
              display_name: 'ACME',
              auth_methods: ['device_authorization'],
              availability: 'unavailable',
              models: MODELS,
            },
          ],
        }),
        true,
      ),
    ).toMatchObject({ error: 'credential_provider_unavailable' });
  });
});

describe('what a page is told', () => {
  it('offers exactly what the Node reported for the derived provider', () => {
    const view = modelView(project(), 'acme-llm', capabilities(), true);
    expect(view).toMatchObject({
      selected: null,
      requested: null,
      state: 'legacy_default',
      provider_id: 'acme-llm',
      blocked: null,
      run_block: null,
    });
    expect(view.available).toEqual(MODELS);
  });

  it('offers nothing when the report cannot be trusted, and says why', () => {
    for (const [view, error] of [
      [modelView(project(), 'acme-llm', capabilities(), false), 'node_offline'],
      [modelView(project(), 'acme-llm', capabilities({ stale: true }), true), 'capabilities_stale'],
      [modelView(project(), 'acme-llm', { state: 'unknown' }, true), 'capabilities_unknown'],
      [
        modelView(project({ credential_id: null }), null, capabilities(), true),
        'credential_not_assigned',
      ],
    ] as const) {
      expect(view.available).toEqual([]);
      expect(view.blocked?.error).toBe(error);
    }
  });

  it('names what is in flight while it is in flight, and not afterwards', () => {
    const pending = modelView(
      project({
        model: 'quokka-9.2',
        requested_model: 'quokka-9.2:fast',
        model_selection_state: 'pending',
      }),
      'acme-llm',
      capabilities(),
      true,
    );
    expect(pending).toMatchObject({
      selected: 'quokka-9.2',
      requested: 'quokka-9.2:fast',
      run_block: { error: 'model_selection_pending' },
    });

    const failed = modelView(
      project({
        model: 'quokka-9.2',
        requested_model: 'quokka-9.2:fast',
        model_selection_state: 'failed',
        model_selection_failure: 'worker_unhealthy',
      }),
      'acme-llm',
      capabilities(),
      true,
    );
    expect(failed.requested).toBeNull();
    expect(failed.selected).toBe('quokka-9.2');
    expect(failed.run_block).toBeNull();
  });
});

describe('when a run must wait', () => {
  it('holds only while nothing knows what the worker runs', () => {
    expect(runModelBlock(project())).toBeNull();
    expect(
      runModelBlock(project({ model: 'quokka-9.2', model_selection_state: 'applied' })),
    ).toBeNull();
    expect(
      runModelBlock(project({ model_selection_state: 'failed', model_selection_failure: 'x' })),
    ).toBeNull();
    expect(runModelBlock(project({ model_selection_state: 'pending' }))).toMatchObject({
      error: 'model_selection_pending',
    });
    expect(runModelBlock(project({ model_selection_state: 'inconsistent' }))).toMatchObject({
      error: 'model_selection_inconsistent',
    });
    // A state this build does not know is read as the safest true thing.
    expect(runModelBlock(project({ model_selection_state: 'from-the-future' }))).toBeNull();
  });
});

describe('what crosses to the Node', () => {
  it('carries the version, the ids, the generation and the model, and nothing else', () => {
    const payload = modelSelectPayload(
      project({ requested_model: 'quokka-9.2:fast', model_selection_generation: 3 }),
    );
    expect(payload).toEqual({
      version: MODEL_SELECT_COMMAND_VERSION,
      project_id: 'prj_1',
      node_project_id: 'np_1',
      selection_generation: 3,
      model: 'quokka-9.2:fast',
    });
    expect(MODEL_SELECT_COMMAND).toBe('project.model.select');
  });

  it('stores a failure code only when it is one this build knows', () => {
    expect(knownModelFailure('worker_unhealthy')).toBe('worker_unhealthy');
    expect(knownModelFailure('model_not_supported')).toBe('model_not_supported');
    expect(knownModelFailure('invented-by-a-newer-node')).toBeNull();
    expect(knownModelFailure(7)).toBeNull();
  });
});
