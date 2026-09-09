import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MAX_AUTH_METHODS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_ID_LENGTH,
  MAX_PROVIDERS,
  readSnapshot,
  snapshotFromCapabilities,
  SUPPORTED_SCHEMA_VERSION,
} from '../../src/provider-capabilities.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src');

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'openai-codex',
    display_name: 'OpenAI Codex',
    auth_methods: ['device_authorization'],
    availability: 'available',
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    runtime_release: 'v0.1.0-alpha.23',
    reported_at: 1_757_000_000,
    providers: [provider()],
    ...overrides,
  };
}

describe('reading what a Node reported', () => {
  it('accepts a well-formed snapshot and keeps every field', () => {
    const verdict = readSnapshot(snapshot());
    expect(verdict.status).toBe('ok');
    if (verdict.status !== 'ok') throw new Error('unreachable');
    expect(verdict.snapshot.runtime_release).toBe('v0.1.0-alpha.23');
    expect(verdict.snapshot.providers).toEqual([
      {
        id: 'openai-codex',
        display_name: 'OpenAI Codex',
        auth_methods: ['device_authorization'],
        availability: 'available',
      },
    ]);
  });

  it('keeps the reason a provider is out of reach', () => {
    const verdict = readSnapshot(
      snapshot({
        providers: [
          provider({ availability: 'unavailable', unavailable_reason: 'runtime_missing' }),
        ],
      }),
    );
    if (verdict.status !== 'ok') throw new Error('unreachable');
    expect(verdict.snapshot.providers[0]?.unavailable_reason).toBe('runtime_missing');
  });

  /**
   * The refusal that matters most. A shape this build cannot read is reported as
   * such and never interpreted — reading half of an unknown version is how one
   * silently becomes a supported provider.
   */
  it('refuses a schema version it does not have, without looking inside', () => {
    const verdict = readSnapshot(
      snapshot({
        schema_version: 99,
        providers: [provider({ id: 'anything-at-all' })],
      }),
    );
    expect(verdict).toEqual({ status: 'unsupported_schema', schemaVersion: 99 });
    expect(verdict).not.toHaveProperty('snapshot');
  });

  it('refuses anything that is not a report', () => {
    for (const bad of [null, undefined, 42, 'snapshot', [], { schema_version: 0 }, {}]) {
      expect(readSnapshot(bad).status, `${JSON.stringify(bad)}`).toBe('malformed');
    }
  });

  it('refuses a report missing the things a snapshot is made of', () => {
    for (const override of [
      { runtime_release: undefined },
      { runtime_release: '' },
      { runtime_release: 'x'.repeat(65) },
      { reported_at: undefined },
      { reported_at: -1 },
      { reported_at: 'yesterday' },
      { providers: undefined },
      { providers: {} },
    ]) {
      expect(readSnapshot(snapshot(override)).status, JSON.stringify(override)).toBe('malformed');
    }
  });
});

describe('the report is authenticated, not trusted', () => {
  it('refuses more providers than the bound allows', () => {
    const many = Array.from({ length: MAX_PROVIDERS + 1 }, (_, n) => provider({ id: `p${n}` }));
    expect(readSnapshot(snapshot({ providers: many })).status).toBe('malformed');
  });

  it('accepts exactly the bound', () => {
    const atLimit = Array.from({ length: MAX_PROVIDERS }, (_, n) => provider({ id: `p${n}` }));
    expect(readSnapshot(snapshot({ providers: atLimit })).status).toBe('ok');
  });

  /** Ids reach a URL and a database key, so the alphabet is closed. */
  it('refuses an id that could mean something else somewhere else', () => {
    for (const id of [
      '',
      '../etc/passwd',
      'a/b',
      'OpenAI',
      'openai codex',
      'openai_codex',
      'x'.repeat(MAX_ID_LENGTH + 1),
      42,
    ]) {
      expect(readSnapshot(snapshot({ providers: [provider({ id })] })).status, `${id}`).toBe(
        'malformed',
      );
    }
  });

  it('refuses two rows for one provider', () => {
    expect(readSnapshot(snapshot({ providers: [provider(), provider()] })).status).toBe(
      'malformed',
    );
  });

  it('refuses an unusable display name', () => {
    for (const display_name of ['', 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1), 7, null]) {
      expect(readSnapshot(snapshot({ providers: [provider({ display_name })] })).status).toBe(
        'malformed',
      );
    }
  });

  it('refuses an unusable number or shape of authentication methods', () => {
    for (const auth_methods of [
      [],
      Array.from({ length: MAX_AUTH_METHODS + 1 }, (_, n) => `m${n}`),
      'device_authorization',
      [''],
      ['a b'],
      ['../x'],
      ['x'.repeat(33)],
      [null],
    ]) {
      expect(
        readSnapshot(snapshot({ providers: [provider({ auth_methods })] })).status,
        JSON.stringify(auth_methods),
      ).toBe('malformed');
    }
  });

  it('refuses an availability it does not know rather than passing it through', () => {
    for (const availability of ['maybe', '', 'AVAILABLE', 1, null]) {
      expect(readSnapshot(snapshot({ providers: [provider({ availability })] })).status).toBe(
        'malformed',
      );
    }
  });

  it('refuses an unreadable reason', () => {
    expect(
      readSnapshot(
        snapshot({
          providers: [
            provider({ availability: 'unavailable', unavailable_reason: 'a reason with spaces' }),
          ],
        }),
      ).status,
    ).toBe('malformed');
  });
});

describe('the Control Plane owns no provider list', () => {
  /**
   * The architectural claim, tested behaviourally: a provider this build has
   * never heard of is stored and returned exactly as sent. Anything else would
   * mean a list lives here, and a Node's honest report about its own runtime
   * could be overruled by a deploy of this service.
   */
  it('accepts a provider it has never heard of, unchanged', () => {
    const verdict = readSnapshot(
      snapshot({
        providers: [
          provider({ id: 'acme-llm', display_name: 'Acme LLM', auth_methods: ['smartcard'] }),
        ],
      }),
    );
    expect(verdict.status).toBe('ok');
    if (verdict.status !== 'ok') throw new Error('unreachable');
    expect(verdict.snapshot.providers[0]).toEqual({
      id: 'acme-llm',
      display_name: 'Acme LLM',
      auth_methods: ['smartcard'],
      availability: 'available',
    });
  });

  /**
   * And structurally: no module here may carry a set of provider identifiers.
   * A list would be the duplicate authority the architecture exists to prevent —
   * two places deciding what a host supports, and the wrong one owning the UI.
   */
  it('names no provider anywhere in its own source', () => {
    const modules = ['provider-capabilities.ts', 'provider-capabilities-repository.ts'];
    for (const module of modules) {
      const source = readFileSync(path.join(SRC, module), 'utf8');
      // Comments explain the design and may name one by way of example; code
      // may not. Strip comments, then look.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      for (const name of ['openai-codex', 'openai', 'anthropic', 'gemini', 'codex']) {
        expect(code.toLowerCase(), `${module} must not name ${name}`).not.toContain(name);
      }
    }
  });
});

describe('a Node that never spoke is not a Node with no providers', () => {
  it('returns nothing when the capability payload carries no report', () => {
    expect(snapshotFromCapabilities({ runtime_kinds: ['hermes-loop'] })).toBeNull();
    expect(snapshotFromCapabilities({ provider_capabilities: null })).toBeNull();
    expect(snapshotFromCapabilities(null)).toBeNull();
    expect(snapshotFromCapabilities('capabilities')).toBeNull();
  });

  it('returns the report when one is there, without reading it', () => {
    const reported = { schema_version: 1 };
    expect(snapshotFromCapabilities({ provider_capabilities: reported })).toBe(reported);
  });
});
