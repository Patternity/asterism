/**
 * Configuration loading, with attention to the values that decide whether a
 * deployment is safe rather than merely working.
 */
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';

const PRODUCTION = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://asterism:secret@postgres:5432/asterism_cp',
  PUBLIC_BASE_URL: 'https://onsetexpo.textura.agency',
  ALLOWED_ORIGINS: 'https://onsetexpo.textura.agency,https://5.161.156.206',
  ALLOW_PLAINTEXT: 'false',
  OPERATOR_COMPATIBILITY: 'false',
};

describe('reverse-proxy trust', () => {
  it('ignores forwarded headers by default', () => {
    expect(loadConfig({ ...PRODUCTION }).trustProxy).toBe(false);
  });

  it('accepts a single hop address, so one known proxy is trusted and no other', () => {
    expect(loadConfig({ ...PRODUCTION, TRUST_PROXY: '172.21.0.1' }).trustProxy).toBe('172.21.0.1');
  });

  it('accepts a CIDR and a list for deployments whose hop address is not fixed', () => {
    expect(loadConfig({ ...PRODUCTION, TRUST_PROXY: '172.21.0.0/16' }).trustProxy).toBe(
      '172.21.0.0/16',
    );
    expect(loadConfig({ ...PRODUCTION, TRUST_PROXY: '127.0.0.1,172.21.0.1' }).trustProxy).toBe(
      '127.0.0.1,172.21.0.1',
    );
  });

  it('still understands the blunt boolean forms', () => {
    expect(loadConfig({ ...PRODUCTION, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...PRODUCTION, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });

  it('treats an empty value as no trust rather than as an empty allowlist', () => {
    expect(loadConfig({ ...PRODUCTION, TRUST_PROXY: '' }).trustProxy).toBe(false);
  });
});

describe('production refusals', () => {
  it('refuses the plaintext shortcut', () => {
    expect(() => loadConfig({ ...PRODUCTION, ALLOW_PLAINTEXT: 'true' })).toThrow(
      /ALLOW_PLAINTEXT must not be enabled in production/,
    );
  });

  it('refuses a plaintext public base URL', () => {
    expect(() =>
      loadConfig({
        ...PRODUCTION,
        PUBLIC_BASE_URL: 'http://onsetexpo.textura.agency',
        ALLOWED_ORIGINS: 'http://onsetexpo.textura.agency',
      }),
    ).toThrow(/PUBLIC_BASE_URL must use https/);
  });

  it('refuses a plaintext allowed origin', () => {
    expect(() =>
      loadConfig({ ...PRODUCTION, ALLOWED_ORIGINS: `${PRODUCTION.PUBLIC_BASE_URL},http://a.test` }),
    ).toThrow(/ALLOWED_ORIGINS must use https/);
  });

  it('accepts the deployed staging shape', () => {
    const config = loadConfig({ ...PRODUCTION, TRUST_PROXY: '172.21.0.1' });
    expect(config.nodeEnv).toBe('production');
    expect(config.allowPlaintext).toBe(false);
    expect(config.operatorCompatibility).toBe(false);
    expect(config.allowedOrigins).toEqual([
      'https://onsetexpo.textura.agency',
      'https://5.161.156.206',
    ]);
  });
});
