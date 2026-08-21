import { describe, expect, it } from 'vitest';

import { nodeCapabilityView } from '../../src/node-capabilities.js';

const advertising = (policies: unknown) => ({
  connection_state: 'online',
  capabilities: { approvals: { run_approval_policy: policies } },
});

/**
 * Support is read from the authenticated advertisement and nothing else. A
 * version string or a release tag is a guess about a remote process, and a
 * guess that enables a control produces a button whose command is refused.
 */
describe('node capability view', () => {
  it('reports support when the Node advertises the run-scoped policy', () => {
    const view = nodeCapabilityView(advertising(['manual', 'allow_all_for_run']));
    expect(view.supports_run_approval_policy).toBe(true);
    expect(view.run_approval_policy_available).toBe(true);
    expect(view.capabilities_known).toBe(true);
    expect(view.run_approval_policy).toEqual(['manual', 'allow_all_for_run']);
  });

  it('treats a manual-only Node as unsupported', () => {
    const view = nodeCapabilityView(advertising(['manual']));
    expect(view.capabilities_known).toBe(true);
    expect(view.supports_run_approval_policy).toBe(false);
    expect(view.run_approval_policy_available).toBe(false);
  });

  it('treats an older Node that omits the capability as unsupported', () => {
    const view = nodeCapabilityView({
      connection_state: 'online',
      capabilities: { approvals: { choices: ['once', 'deny'] } },
    });
    expect(view.capabilities_known).toBe(true);
    expect(view.supports_run_approval_policy).toBe(false);
    expect(view.run_approval_policy).toEqual([]);
  });

  it('does not mistake the handshake digest for a negotiated capability set', () => {
    // The node row is seeded with a digest before `capabilities.get` returns.
    // Reading that as "known" would report a definite absence during the very
    // window where nothing has been negotiated.
    const seeded = nodeCapabilityView({
      connection_state: 'online',
      capabilities: { digest: 'c6e1076d' },
    });
    expect(seeded.capabilities_known).toBe(false);
    expect(seeded.supports_run_approval_policy).toBe(false);
  });

  it('separates "never negotiated" from "advertises nothing"', () => {
    // Both hide the control, but only one of them may later turn into support,
    // and an operator reading the state deserves the difference.
    const never = nodeCapabilityView({ connection_state: 'offline', capabilities: {} });
    expect(never.capabilities_known).toBe(false);
    expect(never.supports_run_approval_policy).toBe(false);
  });

  it('keeps support but withdraws availability while the Node is offline', () => {
    const view = nodeCapabilityView({
      connection_state: 'offline',
      capabilities: { approvals: { run_approval_policy: ['manual', 'allow_all_for_run'] } },
    });
    expect(view.supports_run_approval_policy).toBe(true);
    expect(view.run_approval_policy_available).toBe(false);
    expect(view.connection_status).toBe('offline');
  });

  it('drops an unknown future policy rather than forwarding it', () => {
    // A value this Control Plane has never heard of must not reach a client
    // that might render a control for it.
    const view = nodeCapabilityView(advertising(['manual', 'allow_everything_forever']));
    expect(view.run_approval_policy).toEqual(['manual']);
    expect(view.supports_run_approval_policy).toBe(false);
  });

  it('ignores a malformed advertisement instead of trusting it', () => {
    expect(nodeCapabilityView(advertising('allow_all_for_run')).run_approval_policy).toEqual([]);
    expect(nodeCapabilityView(advertising([1, null])).run_approval_policy).toEqual([]);
    expect(
      nodeCapabilityView({ connection_state: 'online', capabilities: null }).capabilities_known,
    ).toBe(false);
  });

  it('reports an absent node without inventing support', () => {
    const view = nodeCapabilityView(null);
    expect(view.connection_status).toBe('unknown');
    expect(view.capabilities_known).toBe(false);
    expect(view.supports_run_approval_policy).toBe(false);
  });

  it('exposes no identity or session material', () => {
    const view = nodeCapabilityView({
      connection_state: 'online',
      capabilities: { approvals: { run_approval_policy: ['allow_all_for_run'] } },
      // Fields a project reader must never receive through this fragment.
      ...({ public_key: 'k', fingerprint: 'f', last_session_id: 's' } as object),
    });
    const keys = Object.keys(view);
    for (const forbidden of ['public_key', 'fingerprint', 'last_session_id', 'capabilities']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
