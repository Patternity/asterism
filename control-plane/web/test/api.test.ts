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

  it('mints a replacement token and replays the write when the cookie is gone', async () => {
    // The state that used to be unrecoverable: a live session with no CSRF
    // cookie, so the header is absent and every write is refused.
    document.cookie = 'asterism_csrf=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    const refused = () =>
      new Response(JSON.stringify({ error: 'csrf_failed' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    const accepted = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(accepted());

    await expect(apiRequest('/api/v1/test', { method: 'POST', body: '{}' })).resolves.toEqual({
      ok: true,
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/test',
      '/api/v1/auth/csrf',
      '/api/v1/test',
    ]);
  });

  it('surfaces the refusal instead of looping when the token cannot be replaced', async () => {
    document.cookie = 'asterism_csrf=stale; path=/';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'csrf_failed' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(apiRequest('/api/v1/test', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      status: 403,
      code: 'csrf_failed',
    });

    // The original and the mint. A mint that fails is not worth replaying
    // behind, so the refusal surfaces instead of a third request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('names every organization-scoped cache key with its tenant', () => {
    expect(scopedKey('org-a', 'runs')).toEqual(['organization', 'org-a', 'runs']);
    expect(scopedKey('org-b', 'runs')).not.toEqual(scopedKey('org-a', 'runs'));
  });
});
