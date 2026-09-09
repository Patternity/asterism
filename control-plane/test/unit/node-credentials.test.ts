import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_STATES,
  MAX_CREDENTIALS,
  MAX_CREDENTIAL_ID_LENGTH,
  MAX_LABEL_LENGTH,
  readCredentials,
  validateCredentialId,
  validateLabel,
} from '../../src/node-credentials.js';

function credential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cred-0011aabb',
    provider_id: 'openai-codex',
    auth_method: 'device_authorization',
    label: 'Existing credential',
    state: 'authorized',
    created_at: 1_757_000_000,
    updated_at: 1_757_000_100,
    ...overrides,
  };
}

describe('reading what a Node reported about its credentials', () => {
  it('accepts a well-formed list and keeps every field', () => {
    const verdict = readCredentials([credential()]);
    expect(verdict.status).toBe('ok');
    if (verdict.status !== 'ok') throw new Error('unreachable');
    expect(verdict.credentials[0]).toEqual({
      id: 'cred-0011aabb',
      provider_id: 'openai-codex',
      auth_method: 'device_authorization',
      label: 'Existing credential',
      state: 'authorized',
      created_at: 1_757_000_000,
      updated_at: 1_757_000_100,
    });
  });

  it('accepts an empty list, which is what a fresh Node reports', () => {
    expect(readCredentials([])).toEqual({ status: 'ok', credentials: [] });
  });

  it('knows every lifecycle state and no others', () => {
    for (const state of CREDENTIAL_STATES) {
      expect(readCredentials([credential({ state })]).status, state).toBe('ok');
    }
    for (const state of ['pending', 'ok', '', 'AUTHORIZED', 7]) {
      expect(readCredentials([credential({ state })]).status).toBe('malformed');
    }
  });

  /**
   * A field nobody planned for is exactly how a token ends up in a database, so
   * the reader builds its result field by field rather than spreading.
   */
  it('drops anything it was not expecting rather than storing it', () => {
    const verdict = readCredentials([
      credential({ access_token: 'secret', refresh_token: 'secret', path: '/var/lib/x' }),
    ]);
    if (verdict.status !== 'ok') throw new Error('unreachable');
    const stored = JSON.stringify(verdict.credentials);
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain('access_token');
    expect(stored).not.toContain('/var/lib');
  });
});

describe('the report is authenticated, not trusted', () => {
  it('refuses anything that is not a list', () => {
    for (const bad of [null, undefined, 42, 'creds', {}]) {
      expect(readCredentials(bad).status).toBe('malformed');
    }
  });

  it('refuses more credentials than the bound allows', () => {
    const many = Array.from({ length: MAX_CREDENTIALS + 1 }, (_, n) =>
      credential({ id: `cred-${n}` }),
    );
    expect(readCredentials(many).status).toBe('malformed');
    expect(readCredentials(many.slice(0, MAX_CREDENTIALS)).status).toBe('ok');
  });

  /** Ids reach a database key and a URL path segment. */
  it('refuses an id that could be read as a path', () => {
    for (const id of [
      '',
      '../etc/passwd',
      'a/b',
      'Cred',
      'cred 1',
      'cred_1',
      'x'.repeat(MAX_CREDENTIAL_ID_LENGTH + 1),
      7,
    ]) {
      expect(readCredentials([credential({ id })]).status, `${id}`).toBe('malformed');
      expect(validateCredentialId(id)).toBeNull();
    }
    expect(validateCredentialId('cred-0011aabb')).toBe('cred-0011aabb');
  });

  it('refuses two rows for one credential', () => {
    expect(readCredentials([credential(), credential()]).status).toBe('malformed');
  });

  it('refuses a label that is unusable, and trims one that is not', () => {
    const newline = String.fromCharCode(10);
    const bell = String.fromCharCode(7);
    for (const label of [
      '',
      '   ',
      'x'.repeat(MAX_LABEL_LENGTH + 1),
      `two${newline}lines`,
      `ring${bell}`,
      9,
    ]) {
      expect(readCredentials([credential({ label })]).status, `${label}`).toBe('malformed');
      expect(validateLabel(label)).toBeNull();
    }
    expect(validateLabel('  Personal account  ')).toBe('Personal account');
  });

  it('refuses an unusable provider or method', () => {
    for (const provider_id of ['', '../x', 'OpenAI', 'a b']) {
      expect(readCredentials([credential({ provider_id })]).status).toBe('malformed');
    }
    for (const auth_method of ['', 'a b', '../x', 'x'.repeat(33)]) {
      expect(readCredentials([credential({ auth_method })]).status).toBe('malformed');
    }
  });

  it('refuses timestamps that are not timestamps', () => {
    for (const override of [
      { created_at: 'yesterday' },
      { updated_at: -1 },
      { created_at: undefined },
      { updated_at: Number.NaN },
    ]) {
      expect(readCredentials([credential(override)]).status).toBe('malformed');
    }
  });
});

describe('there is no provider or method list here', () => {
  /**
   * The same architectural claim as capability discovery: the Node decides what
   * it supports. A provider or a method this build has never seen is stored and
   * shown verbatim, so a Node that gained one is not overruled by a deploy of
   * this service.
   */
  it('accepts a provider and a method it has never heard of', () => {
    const verdict = readCredentials([
      credential({ provider_id: 'acme-llm', auth_method: 'smartcard' }),
    ]);
    expect(verdict.status).toBe('ok');
    if (verdict.status !== 'ok') throw new Error('unreachable');
    expect(verdict.credentials[0]?.provider_id).toBe('acme-llm');
    expect(verdict.credentials[0]?.auth_method).toBe('smartcard');
  });
});
