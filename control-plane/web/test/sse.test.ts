import { describe, expect, it } from 'vitest';

import { cursorStorageKey } from '../src/sse';

describe('SSE cursor isolation', () => {
  it('keeps page-reload cursors separate by organization and run', () => {
    const first = cursorStorageKey('org-a', 'run-1');
    const second = cursorStorageKey('org-b', 'run-1');
    sessionStorage.setItem(first, '12');
    expect(first).not.toBe(second);
    expect(sessionStorage.getItem(second)).toBeNull();
    expect(sessionStorage.getItem(first)).toBe('12');
  });
});
