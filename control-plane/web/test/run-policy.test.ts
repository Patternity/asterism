import { describe, expect, it } from 'vitest';

import {
  BYPASS_CONFIRMATION,
  autoResolvedApprovals,
  bypassWasEverEnabled,
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

  it('hides the control against a Node that cannot honour it', () => {
    expect(
      supportsRunApprovalPolicy({
        approvals: { run_approval_policy: ['manual', 'allow_all_for_run'] },
      }),
    ).toBe(true);
    expect(supportsRunApprovalPolicy({ approvals: { choices: ['once'] } })).toBe(false);
    expect(supportsRunApprovalPolicy(null)).toBe(false);
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
