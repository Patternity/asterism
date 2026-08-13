import { describe, expect, it, vi } from 'vitest';

import { apiRequest, scopedKey } from '../src/api';

describe('browser API client', () => {
  it('uses cookie credentials and the session-bound CSRF cookie for mutations', async () => {
    document.cookie = 'asterism_csrf=csrf-value; path=/';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await apiRequest('/api/v1/test', { method: 'POST', body: '{}' });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-value');
  });

  it('names every organization-scoped cache key with its tenant', () => {
    expect(scopedKey('org-a', 'runs')).toEqual(['organization', 'org-a', 'runs']);
    expect(scopedKey('org-b', 'runs')).not.toEqual(scopedKey('org-a', 'runs'));
  });
});
