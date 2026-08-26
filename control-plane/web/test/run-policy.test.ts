import { describe, expect, it } from 'vitest';

import {
  BYPASS_CONFIRMATION,
  autoResolvedApprovals,
  bypassWasEverEnabled,
  canOfferRunPolicy,
  effectiveRunPolicy,
  pendingApproval,
  policyFromEvents,
  policyLabel,
  supportsRunApprovalPolicy,
} from '../src/run-policy';

describe('run approval policy', () => {
  it('starts every run at manual', () => {
    expect(policyFromEvents([]).policy).toBe('manual');
    expect(policyFromEvents([{ event_type: 'message.delta' }]).policy).toBe('manual');
  });

  it('reads the enabled state and who enabled it from the journal', () => {
    const state = policyFromEvents([
      {
        event_type: 'run.approval_policy.changed',
        payload: { policy: 'allow_all_for_run', actor: 'user-3' },
      },
    ]);
    expect(state.policy).toBe('allow_all_for_run');
    expect(state.enabledBy).toBe('user-3');
  });

  it('follows the last change, so disabling wins over an earlier enable', () => {
    const state = policyFromEvents([
      {
        event_type: 'run.approval_policy.changed',
        payload: { policy: 'allow_all_for_run', actor: 'a' },
      },
      { event_type: 'run.approval_policy.changed', payload: { policy: 'manual', actor: 'a' } },
    ]);
    expect(state.policy).toBe('manual');
    expect(state.enabledBy).toBeNull();
  });

  it('still reports the audit badge after the bypass was turned back off', () => {
    // The run did have it enabled; a completed run must not hide that.
    const events = [
      { event_type: 'run.approval_policy.changed', payload: { policy: 'allow_all_for_run' } },
      { event_type: 'run.approval_policy.changed', payload: { policy: 'manual' } },
    ];
    expect(policyFromEvents(events).policy).toBe('manual');
    expect(bypassWasEverEnabled(events)).toBe(true);
  });

  it('collects the approvals the policy answered', () => {
    const seqs = autoResolvedApprovals([
      { event_type: 'approval.auto_resolved', payload: { approval_seq: 4 } },
      { event_type: 'approval.auto_resolved', payload: { approval_seq: 9 } },
      { event_type: 'approval.request', payload: { approval_seq: 12 } },
    ]);
    expect([...seqs].sort()).toEqual([4, 9]);
  });

  it('renders the control only for a supported, reachable Node', () => {
    expect(
      canOfferRunPolicy({
        supports_run_approval_policy: true,
        run_approval_policy_available: true,
      }),
    ).toBe(true);
  });

  it('hides the control when the capability is absent', () => {
    expect(canOfferRunPolicy({ supports_run_approval_policy: false })).toBe(false);
    expect(canOfferRunPolicy(undefined)).toBe(false);
    expect(canOfferRunPolicy(null)).toBe(false);
  });

  it('hides the control while support is unknown', () => {
    // Never negotiated is not the same as "advertises nothing", and neither
    // may render a control.
    expect(canOfferRunPolicy({ capabilities_known: false })).toBe(false);
  });

  it('withdraws the control while a supported Node is offline', () => {
    // The command would queue against a Node that cannot answer, and the
    // operator would be told the bypass is on with nothing enforcing it.
    const offline = {
      supports_run_approval_policy: true,
      run_approval_policy_available: false,
      connection_status: 'offline',
    };
    expect(supportsRunApprovalPolicy(offline)).toBe(true);
    expect(canOfferRunPolicy(offline)).toBe(false);
  });

  it('names the consequences rather than the policy', () => {
    // An operator decides about what the agent may do, not about an enum value.
    expect(BYPASS_CONFIRMATION).toContain('delete project data');
    expect(BYPASS_CONFIRMATION).toContain('ends with this run');
  });

  it('labels the policies in product language', () => {
    expect(policyLabel('allow_all_for_run')).toBe('Allow all for this run');
    expect(policyLabel('manual')).toBe('Manual approval');
  });
});

describe('which approval is still waiting', () => {
  const event = (event_type: string, payload: Record<string, unknown> = {}) => ({
    event_type,
    payload,
  });

  it('finds a request that has not been answered', () => {
    const pending = pendingApproval([
      event('tool.started', { tool: 'terminal' }),
      event('approval.request', { description: 'Run a command' }),
    ]);
    expect(pending?.payload.description).toBe('Run a command');
  });

  it('treats a request answered by an operator as settled', () => {
    expect(
      pendingApproval([
        event('approval.request', { description: 'Run a command' }),
        event('asterism.approval.decision', { choice: 'once' }),
        event('approval.responded', { choice: 'once' }),
      ]),
    ).toBeNull();
  });

  it('treats a request the run answered under its own policy as settled', () => {
    // This is the case that made the bypass button look broken: a run that
    // answers continuously leaves a trail of resolved requests behind it.
    expect(
      pendingApproval([
        event('approval.request', { description: 'first' }),
        event('approval.auto_resolved', { choice: 'once' }),
        event('approval.responded', { choice: 'once' }),
        event('approval.request', { description: 'second' }),
        event('approval.auto_resolved', { choice: 'once' }),
        event('approval.responded', { choice: 'once' }),
      ]),
    ).toBeNull();
  });

  it('returns the newest request when an earlier one was already answered', () => {
    const pending = pendingApproval([
      event('approval.request', { description: 'first' }),
      event('approval.responded', { choice: 'once' }),
      event('tool.started', { tool: 'terminal' }),
      event('approval.request', { description: 'second' }),
    ]);
    expect(pending?.payload.description).toBe('second');
  });

  it('reports nothing for a journal window that never saw a request', () => {
    // The caller must not hide the prompt on this: the run's status decides
    // whether it is waiting, and a truncated window would otherwise strand it.
    expect(pendingApproval([event('tool.started', { tool: 'terminal' })])).toBeNull();
  });
});

describe('which policy the console believes', () => {
  const bypassEvent = {
    event_type: 'run.approval_policy.changed',
    payload: { policy: 'allow_all_for_run', actor: 'owner' },
  };

  it('trusts what the server reported over its own journal window', () => {
    // The window has no policy event at all — the cursor skipped past it.
    const state = effectiveRunPolicy(
      {
        approval_policy: 'allow_all_for_run',
        approval_policy_actor: 'owner',
        approval_policy_changed_at: '2026-01-01T00:00:00Z',
      },
      [{ event_type: 'approval.request', payload: {} }],
    );
    expect(state.policy).toBe('allow_all_for_run');
    expect(state.enabledBy).toBe('owner');
    expect(state.enabledAt).toBe('2026-01-01T00:00:00Z');
  });

  it('believes a reported return to manual even when the window still shows the bypass', () => {
    const state = effectiveRunPolicy({ approval_policy: 'manual' }, [bypassEvent]);
    expect(state.policy).toBe('manual');
    expect(state.enabledBy).toBeNull();
  });

  it('falls back to the journal against a Control Plane that reports nothing', () => {
    expect(effectiveRunPolicy({}, [bypassEvent]).policy).toBe('allow_all_for_run');
    expect(effectiveRunPolicy({ approval_policy: null }, []).policy).toBe('manual');
  });

  it('ignores a value it does not understand rather than trusting it blindly', () => {
    expect(effectiveRunPolicy({ approval_policy: 'something_new' }, [bypassEvent]).policy).toBe(
      'allow_all_for_run',
    );
  });
});
