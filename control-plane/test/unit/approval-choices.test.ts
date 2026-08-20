import { describe, expect, it } from 'vitest';

import {
  APPROVAL_CHOICES,
  PERSISTENT_APPROVAL_NOT_SUPPORTED,
  isPersistentApprovalRequest,
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
