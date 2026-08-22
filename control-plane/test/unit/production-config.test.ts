/**
 * Each rejection the production guard is responsible for.
 *
 * The guard exists to fail a deployment, so every test here starts from a
 * configuration that passes and breaks exactly one thing. A check that cannot
 * be shown to reject is not a check.
 */
import { describe, expect, it } from 'vitest';

import {
  auditProductionConfiguration,
  type ComposeConfiguration,
} from '../../src/production-config.js';

const NAME = 'https://onsetexpo.textura.agency';
const IP = 'https://5.161.156.206';

function configuration(
  overrides: {
    serving?: Record<string, unknown>;
    servingPorts?: unknown[];
    database?: Record<string, unknown>;
    databasePorts?: unknown[];
  } = {},
): ComposeConfiguration {
  return {
    services: {
      'control-plane': {
        environment: {
          NODE_ENV: 'production',
          PUBLIC_BASE_URL: NAME,
          ALLOWED_ORIGINS: `${NAME},${IP}`,
          ALLOW_PLAINTEXT: 'false',
          OPERATOR_COMPATIBILITY: 'false',
          DATABASE_URL: 'postgres://asterism:secret@postgres:5432/asterism_cp',
          TRUST_PROXY: '172.21.0.1',
          ...overrides.serving,
        } as Record<string, string>,
        ports: (overrides.servingPorts ?? [
          { mode: 'ingress', host_ip: '127.0.0.1', target: 8080, published: '8080' },
        ]) as never,
      },
      postgres: {
        environment: {
          POSTGRES_PASSWORD: 'a-value',
          ...overrides.database,
        } as Record<string, string>,
        ports: (overrides.databasePorts ?? []) as never,
      },
    },
  };
}

function checks(config: ComposeConfiguration): string[] {
  return auditProductionConfiguration(config).map((problem) => problem.check);
}

describe('production configuration guard', () => {
  it('accepts the intended production shape', () => {
    expect(auditProductionConfiguration(configuration())).toEqual([]);
  });

  it('refuses a stack that is not marked production', () => {
    expect(checks(configuration({ serving: { NODE_ENV: 'development' } }))).toContain('node_env');
  });

  it('refuses a public base URL that is not https', () => {
    expect(
      checks(
        configuration({
          serving: {
            PUBLIC_BASE_URL: 'http://onsetexpo.textura.agency',
            ALLOWED_ORIGINS: 'http://onsetexpo.textura.agency',
          },
        }),
      ),
    ).toContain('public_base_url');
  });

  it('refuses the plaintext development shortcut', () => {
    expect(checks(configuration({ serving: { ALLOW_PLAINTEXT: 'true' } }))).toContain(
      'allow_plaintext',
    );
  });

  it('refuses compatibility mode, and refuses leaving it to a default', () => {
    expect(checks(configuration({ serving: { OPERATOR_COMPATIBILITY: 'true' } }))).toContain(
      'operator_compatibility',
    );
    const withoutValue = configuration();
    delete withoutValue.services!['control-plane']!.environment!.OPERATOR_COMPATIBILITY;
    expect(checks(withoutValue)).toContain('operator_compatibility');
  });

  it('refuses a plaintext entry among the allowed origins', () => {
    expect(
      checks(configuration({ serving: { ALLOWED_ORIGINS: `${NAME},http://internal.test` } })),
    ).toContain('allowed_origins');
  });

  it('refuses a public base URL that is missing from the allowed origins', () => {
    expect(checks(configuration({ serving: { ALLOWED_ORIGINS: IP } }))).toContain(
      'allowed_origins',
    );
  });

  it('refuses an empty allowed-origin list', () => {
    expect(checks(configuration({ serving: { ALLOWED_ORIGINS: '' } }))).toContain(
      'allowed_origins',
    );
  });

  it('refuses a stack whose secrets are missing', () => {
    const withoutDatabaseUrl = configuration();
    delete withoutDatabaseUrl.services!['control-plane']!.environment!.DATABASE_URL;
    expect(checks(withoutDatabaseUrl)).toContain('secrets');

    const withoutPassword = configuration();
    delete withoutPassword.services!.postgres!.environment!.POSTGRES_PASSWORD;
    expect(checks(withoutPassword)).toContain('secrets');
  });

  it('refuses a publicly published database', () => {
    expect(
      checks(
        configuration({
          databasePorts: [{ mode: 'ingress', host_ip: '0.0.0.0', target: 5432, published: '5432' }],
        }),
      ),
    ).toContain('database_exposure');
  });

  it('refuses an API bound past the reverse proxy', () => {
    expect(
      checks(
        configuration({
          servingPorts: [{ mode: 'ingress', host_ip: '0.0.0.0', target: 8080, published: '8080' }],
        }),
      ),
    ).toContain('proxy_boundary');

    // Compose treats an omitted host_ip as every interface, so an absent value
    // is a failure rather than missing data.
    expect(
      checks(
        configuration({ servingPorts: [{ mode: 'ingress', target: 8080, published: '8080' }] }),
      ),
    ).toContain('proxy_boundary');
  });

  it('reports a configuration with no serving service at all', () => {
    expect(checks({ services: {} })).toEqual(['service_present']);
  });

  it('names every problem at once rather than stopping at the first', () => {
    const problems = auditProductionConfiguration(
      configuration({
        serving: {
          NODE_ENV: 'development',
          ALLOW_PLAINTEXT: 'true',
          PUBLIC_BASE_URL: 'http://a.test',
          ALLOWED_ORIGINS: 'http://a.test',
        },
      }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(4);
    expect(problems.every((problem) => problem.message.length > 0)).toBe(true);
  });
});
