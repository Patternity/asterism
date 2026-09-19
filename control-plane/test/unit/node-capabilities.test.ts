import { describe, expect, it } from 'vitest';

import {
  decideManagedUpdate,
  nodeCapabilityView,
  readAdvertisedManagedUpdate,
  type AdvertisedManagedUpdate,
  type ManagedUpdateEvidence,
} from '../../src/node-capabilities.js';

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

/**
 * Who may be offered a managed update, in full.
 *
 * The predicate this replaces read `advertised === true || evidence !==
 * 'refused'`, which failed open twice over: a Node nobody had ever asked was
 * treated as capable, and an explicit refusal in the advertisement was
 * overruled by history. Both produced the same thing in the end -- an update
 * operation against a host that was never going to accept it.
 *
 * The table is the specification. Every combination appears, including the
 * ones where the Node's own word and its history disagree.
 */
describe('who may be offered a managed update', () => {
  const ADVERTISED: AdvertisedManagedUpdate[] = ['yes', 'no', 'unreadable', 'absent'];
  const EVIDENCE: (ManagedUpdateEvidence | null | undefined)[] = [
    'accepted',
    'refused',
    'unknown',
    null,
    undefined,
  ];

  /**
   * The only `true` cells in the whole space: the Node says yes, or it says
   * nothing, its capabilities are known, and the last thing it did with an
   * update was take one.
   */
  function expected(
    advertised: AdvertisedManagedUpdate,
    evidence: ManagedUpdateEvidence | null | undefined,
    capabilitiesKnown: boolean,
  ): boolean {
    if (advertised === 'yes') return true;
    if (advertised !== 'absent') return false;
    return capabilitiesKnown && evidence === 'accepted';
  }

  for (const advertised of ADVERTISED) {
    for (const evidence of EVIDENCE) {
      for (const capabilitiesKnown of [true, false]) {
        const want = expected(advertised, evidence, capabilitiesKnown);
        it(`${advertised} + ${String(evidence)} + ${
          capabilitiesKnown ? 'known' : 'unknown'
        } capabilities -> ${want}`, () => {
          expect(decideManagedUpdate({ advertised, capabilitiesKnown, evidence })).toBe(want);
        });
      }
    }
  }

  /** Stated separately from the loop, because these are the whole point. */
  it('lets the Node overrule its own history in both directions', () => {
    // Said no this morning, took one last month: the word wins.
    expect(
      decideManagedUpdate({ advertised: 'no', capabilitiesKnown: true, evidence: 'accepted' }),
    ).toBe(false);
    // Says yes, refused one before it was upgraded: the word wins here too.
    expect(
      decideManagedUpdate({ advertised: 'yes', capabilitiesKnown: true, evidence: 'refused' }),
    ).toBe(true);
  });

  it('never treats an unreadable advertisement as consent', () => {
    for (const evidence of EVIDENCE) {
      expect(
        decideManagedUpdate({ advertised: 'unreadable', capabilitiesKnown: true, evidence }),
      ).toBe(false);
    }
  });
});

describe('reading what a Node advertises about updates', () => {
  const cases: [unknown, AdvertisedManagedUpdate][] = [
    [{ updates: { managed: true, command_version: 1 } }, 'yes'],
    [{ updates: { managed: false } }, 'no'],
    // Spoke about updates without answering the question this build asks.
    [{ updates: {} }, 'unreadable'],
    [{ updates: { command_version: 1 } }, 'unreadable'],
    [{ updates: { managed: 'true' } }, 'unreadable'],
    [{ updates: { managed: 1 } }, 'unreadable'],
    [{ updates: 'managed' }, 'unreadable'],
    [{ updates: [] }, 'unreadable'],
    // Said nothing at all: a build that predates the field.
    [{ projects: { project_provisioning: true } }, 'absent'],
    [{ updates: null }, 'absent'],
    [{}, 'absent'],
    [null, 'absent'],
    [undefined, 'absent'],
  ];

  for (const [capabilities, want] of cases) {
    it(`reads ${JSON.stringify(capabilities)} as ${want}`, () => {
      expect(readAdvertisedManagedUpdate(capabilities as Record<string, unknown> | null)).toBe(
        want,
      );
    });
  }
});

/** The same decision, as the API hands it to a browser. */
describe('the managed-update fields the console is given', () => {
  const view = (capabilities: unknown, evidence: ManagedUpdateEvidence, online = true) =>
    nodeCapabilityView(
      {
        connection_state: online ? 'online' : 'offline',
        capabilities: capabilities as Record<string, unknown> | null,
      },
      evidence,
    );

  it('follows the advertisement when there is one', () => {
    expect(view({ updates: { managed: true } }, 'refused').supports_managed_update).toBe(true);
    expect(view({ updates: { managed: false } }, 'accepted').supports_managed_update).toBe(false);
    expect(view({ updates: { managed: 'yes' } }, 'accepted').supports_managed_update).toBe(false);
  });

  it('offers a legacy Node an update only on an accepted attempt', () => {
    const legacy = { projects: { project_provisioning: true } };
    expect(view(legacy, 'accepted').supports_managed_update).toBe(true);
    expect(view(legacy, 'refused').supports_managed_update).toBe(false);
    expect(view(legacy, 'unknown').supports_managed_update).toBe(false);
  });

  it('will not read history about a Node that has never handshaken', () => {
    // Only the digest the handshake seeds: nothing has been negotiated yet, so
    // an absent advertisement is ignorance rather than a fact.
    expect(view({ digest: 'abc' }, 'accepted').supports_managed_update).toBe(false);
    expect(view(null, 'accepted').supports_managed_update).toBe(false);
  });

  it('defaults to refusing when the caller looked up no evidence', () => {
    expect(
      nodeCapabilityView({ connection_state: 'online', capabilities: { projects: {} } })
        .supports_managed_update,
    ).toBe(false);
  });

  it('is supported but not available while the Node is unreachable', () => {
    const offline = view({ updates: { managed: true } }, 'unknown', false);
    expect(offline.supports_managed_update).toBe(true);
    expect(offline.managed_update_available).toBe(false);
  });
});
