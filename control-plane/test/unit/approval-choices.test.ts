import { describe, expect, it } from 'vitest';

import {
  APPROVAL_CHOICES,
  PERSISTENT_APPROVAL_NOT_SUPPORTED,
  RUN_APPROVAL_POLICIES,
  isPersistentApprovalRequest,
  supportsRunApprovalPolicy,
} from '../../src/approval-choices.js';

/**
 * Hermes turns an "always" answer into a permanent `command_allowlist` entry
 * that suppresses every later approval in that command category — including
 * recursive delete — and nothing in Asterism displays or revokes it. Until that
 * surface exists the choice must not be offered or accepted anywhere.
 */
describe('approval choices', () => {
  it('does not offer a persistent grant', () => {
    expect(APPROVAL_CHOICES).not.toContain('always');
  });

  it('still offers the reversible choices', () => {
    expect([...APPROVAL_CHOICES]).toEqual(['once', 'session', 'deny']);
  });

  it('recognises a persistent request so it can be refused by name', () => {
    expect(isPersistentApprovalRequest('always')).toBe(true);
  });

  it('does not mistake a supported choice for a persistent one', () => {
    for (const choice of APPROVAL_CHOICES) {
      expect(isPersistentApprovalRequest(choice)).toBe(false);
    }
    expect(isPersistentApprovalRequest(undefined)).toBe(false);
    expect(isPersistentApprovalRequest({ choice: 'always' })).toBe(false);
  });

  it('exposes a stable error code for clients to branch on', () => {
    expect(PERSISTENT_APPROVAL_NOT_SUPPORTED).toBe('persistent_approval_not_supported');
  });
});

/**
 * `allow_all_for_run` is the narrow answer to the same wish `always` served:
 * stop asking. It is scoped to one run, so it must never be confused with the
 * persistent grant, and a Node too old to honour it must not be sent it.
 */
describe('run approval policy', () => {
  it('offers exactly the two run-scoped policies', () => {
    expect([...RUN_APPROVAL_POLICIES]).toEqual(['manual', 'allow_all_for_run']);
  });

  it('is not the persistent grant under a new name', () => {
    expect(RUN_APPROVAL_POLICIES).not.toContain('always');
  });

  it('detects a Node that advertises the capability', () => {
    expect(
      supportsRunApprovalPolicy({
        approvals: { run_approval_policy: ['manual', 'allow_all_for_run'] },
      }),
    ).toBe(true);
  });

  it('treats an older Node as unsupported so the control stays hidden', () => {
    expect(supportsRunApprovalPolicy({ approvals: { choices: ['once', 'deny'] } })).toBe(false);
    expect(supportsRunApprovalPolicy({})).toBe(false);
    expect(supportsRunApprovalPolicy(null)).toBe(false);
  });

  it('does not accept a Node advertising only manual as supporting bypass', () => {
    expect(supportsRunApprovalPolicy({ approvals: { run_approval_policy: ['manual'] } })).toBe(
      false,
    );
  });
});
