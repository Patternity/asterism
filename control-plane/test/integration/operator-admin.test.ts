/**
 * Local operator administration against a real PostgreSQL database.
 *
 * The CLI is exercised as a subprocess, not as an imported function, because
 * the properties that matter are process-level: a password must not reach argv
 * or the environment, a non-interactive run without `--password-stdin` must
 * fail closed, and nothing secret may appear on stdout or stderr. Importing
 * `main()` would test the happy path while quietly skipping all of that.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  authenticatePassword,
  createSession,
  normalizeEmail,
  resolveSession,
} from '../../src/auth.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { LOCAL_RECOVERY_ACTOR } from '../../src/operator-admin.js';
import { BOOTSTRAP_ORGANIZATION_ID } from '../../src/tenancy.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/cli/operator.ts');

/** A password that satisfies the production minimum length. */
const PASSWORD = 'acceptance-secret-value-01';
const REPLACEMENT = 'acceptance-secret-value-02';
const EMAIL = 'acceptance@asterism.test';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI the way an operator would, with the password only ever on stdin.
 *
 * `stdin: null` means "no password offered at all", which is the fail-closed
 * case; the child never gets a TTY here, so the interactive prompt is
 * unreachable by construction.
 */
function runCli(
  args: string[],
  input: string | null = null,
  environment: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', CLI, ...args], {
      env: { ...process.env, DATABASE_URL, ...environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input === null) child.stdin.end();
    else child.stdin.end(input);
  });
}

function parseReport(result: CliResult): Record<string, unknown> {
  const line = result.stdout.trim().split('\n').filter(Boolean).pop();
  expect(line, `no report on stdout; stderr was ${result.stderr}`).toBeTruthy();
  return JSON.parse(line as string) as Record<string, unknown>;
}

/**
 * Find the typed refusal on stderr.
 *
 * The last line is not necessarily it — a crashing process would append a stack
 * trace — so this scans backwards for the structured line, and fails loudly if
 * there is none.
 */
function parseError(result: CliResult): { code: string; message: string } {
  const lines = result.stderr.trim().split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { error?: { code: string; message: string } };
      if (parsed.error) return parsed.error;
    } catch {
      continue;
    }
  }
  throw new Error(`no typed error on stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
}

async function auditRows(pool: Pool, userId: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM audit_log WHERE target_id = $1 ORDER BY audit_id`,
    [userId],
  );
  return result.rows;
}

describe('local operator administration', () => {
  let pool: Pool;
  let config: Config;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL, 4);
    config = loadConfig({
      DATABASE_URL,
      PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
      ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
      ALLOW_PLAINTEXT: 'true',
      OPERATOR_COMPATIBILITY: 'false',
      NODE_ENV: 'development',
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await rollbackAll(pool);
    await migrate(pool);
  }, 60_000);

  async function createAcceptanceOperator(role = 'developer'): Promise<Record<string, unknown>> {
    const result = await runCli(
      [
        'create',
        '--email',
        EMAIL,
        '--display-name',
        'Acceptance Operator',
        '--organization',
        BOOTSTRAP_ORGANIZATION_ID,
        '--role',
        role,
        '--password-stdin',
        '--yes',
      ],
      `${PASSWORD}\n`,
    );
    expect(result.code, result.stderr).toBe(0);
    return parseReport(result);
  }

  it('creates a temporary operator that can sign in', async () => {
    const report = await createAcceptanceOperator();
    expect(report.result).toBe('ok');
    expect(report.email).toBe(EMAIL);
    expect(report.role).toBe('developer');
    expect(report.enabled).toBe(true);

    const user = await authenticatePassword(pool, config, {
      email: EMAIL,
      password: PASSWORD,
      sourceAddress: '127.0.0.1',
    });
    expect(user?.user_id).toBe(report.user_id);
  });

  it('refuses the wrong password', async () => {
    await createAcceptanceOperator();
    const user = await authenticatePassword(pool, config, {
      email: EMAIL,
      password: 'not-the-password-000',
      sourceAddress: '127.0.0.2',
    });
    expect(user).toBeNull();
  });

  it('refuses a duplicate email cleanly', async () => {
    await createAcceptanceOperator();
    const again = await runCli(
      [
        'create',
        '--email',
        EMAIL.toUpperCase(),
        '--display-name',
        'Second Attempt',
        '--organization',
        BOOTSTRAP_ORGANIZATION_ID,
        '--password-stdin',
        '--yes',
      ],
      `${PASSWORD}\n`,
    );
    expect(again.code).toBe(1);
    expect(parseError(again).code).toBe('duplicate_operator');
  });

  it('assigns organization membership and verifies a named project', async () => {
    const report = await createAcceptanceOperator();
    const membership = await pool.query<{ organization_id: string; role: string }>(
      'SELECT organization_id, role FROM memberships WHERE user_id = $1',
      [report.user_id],
    );
    expect(membership.rows).toEqual([
      { organization_id: BOOTSTRAP_ORGANIZATION_ID, role: 'developer' },
    ]);

    const unknownProject = await runCli(
      [
        'create',
        '--email',
        'second@asterism.test',
        '--display-name',
        'Second',
        '--organization',
        BOOTSTRAP_ORGANIZATION_ID,
        '--project',
        'prj_does_not_exist',
        '--password-stdin',
        '--yes',
      ],
      `${PASSWORD}\n`,
    );
    expect(unknownProject.code).toBe(1);
    expect(parseError(unknownProject).code).toBe('unknown_project');
  });

  it('refuses an unknown organization and an unknown operator', async () => {
    const organization = await runCli(
      [
        'create',
        '--email',
        'nobody@asterism.test',
        '--display-name',
        'Nobody',
        '--organization',
        'org_missing',
        '--password-stdin',
        '--yes',
      ],
      `${PASSWORD}\n`,
    );
    expect(parseError(organization).code).toBe('unknown_organization');

    const operator = await runCli(['disable', '--email', 'ghost@asterism.test', '--yes']);
    expect(parseError(operator).code).toBe('unknown_operator');
  });

  it('invalidates existing sessions when the password is reset', async () => {
    const report = await createAcceptanceOperator();
    const user = await authenticatePassword(pool, config, {
      email: EMAIL,
      password: PASSWORD,
      sourceAddress: '127.0.0.1',
    });
    const session = await createSession(pool, config, {
      user: user!,
      sourceAddress: '127.0.0.1',
      userAgent: 'vitest',
    });
    expect(await resolveSession(pool, config, session.token)).not.toBeNull();

    const reset = await runCli(
      ['set-password', '--email', EMAIL, '--password-stdin', '--yes'],
      `${REPLACEMENT}\n`,
    );
    expect(reset.code, reset.stderr).toBe(0);
    expect(parseReport(reset).sessions_revoked).toBe(1);

    expect(await resolveSession(pool, config, session.token)).toBeNull();
    expect(
      await authenticatePassword(pool, config, {
        email: EMAIL,
        password: PASSWORD,
        sourceAddress: '127.0.0.3',
      }),
      'the old password must stop working',
    ).toBeNull();
    expect(
      await authenticatePassword(pool, config, {
        email: EMAIL,
        password: REPLACEMENT,
        sourceAddress: '127.0.0.4',
      }),
    ).not.toBeNull();

    const audit = await auditRows(pool, report.user_id as string);
    expect(audit.map((row) => row.action)).toContain('operator.set_password');
  });

  it('locks out a disabled operator and lets a re-enabled one back in', async () => {
    await createAcceptanceOperator();
    const disabled = await runCli(['disable', '--email', EMAIL, '--yes']);
    expect(disabled.code, disabled.stderr).toBe(0);
    expect(parseReport(disabled).enabled).toBe(false);

    expect(
      await authenticatePassword(pool, config, {
        email: EMAIL,
        password: PASSWORD,
        sourceAddress: '127.0.0.5',
      }),
    ).toBeNull();

    const enabled = await runCli(['enable', '--email', EMAIL, '--yes']);
    expect(enabled.code, enabled.stderr).toBe(0);
    expect(parseReport(enabled).enabled).toBe(true);

    expect(
      await authenticatePassword(pool, config, {
        email: EMAIL,
        password: PASSWORD,
        sourceAddress: '127.0.0.6',
      }),
    ).not.toBeNull();
  });

  it('revokes sessions on request', async () => {
    await createAcceptanceOperator();
    const user = await authenticatePassword(pool, config, {
      email: EMAIL,
      password: PASSWORD,
      sourceAddress: '127.0.0.1',
    });
    const session = await createSession(pool, config, {
      user: user!,
      sourceAddress: '127.0.0.1',
      userAgent: 'vitest',
    });

    const revoked = await runCli(['revoke-sessions', '--email', EMAIL, '--yes']);
    expect(revoked.code, revoked.stderr).toBe(0);
    expect(parseReport(revoked).sessions_revoked).toBe(1);
    expect(await resolveSession(pool, config, session.token)).toBeNull();
  });

  it('records an audit entry for every operation, naming the local recovery actor', async () => {
    const report = await createAcceptanceOperator();
    const userId = report.user_id as string;
    await runCli(
      ['set-password', '--email', EMAIL, '--password-stdin', '--yes'],
      `${REPLACEMENT}\n`,
    );
    await runCli(['disable', '--email', EMAIL, '--yes']);
    await runCli(['enable', '--email', EMAIL, '--yes']);
    await runCli(['revoke-sessions', '--email', EMAIL, '--yes']);

    const audit = await auditRows(pool, userId);
    expect(audit.map((row) => row.action)).toEqual([
      'operator.create',
      'operator.set_password',
      'operator.disable',
      'operator.enable',
      'operator.revoke_sessions',
    ]);
    for (const row of audit) {
      expect(row.actor).toBe(LOCAL_RECOVERY_ACTOR);
      expect(row.target_type).toBe('user');
      expect(row.organization_id).toBe(BOOTSTRAP_ORGANIZATION_ID);
      expect(row.result).toBe('success');
      expect(row.occurred_at).toBeInstanceOf(Date);
    }
  });

  it('keeps the password out of stdout, stderr, and the audit trail', async () => {
    const create = await runCli(
      [
        'create',
        '--email',
        EMAIL,
        '--display-name',
        'Acceptance Operator',
        '--organization',
        BOOTSTRAP_ORGANIZATION_ID,
        '--password-stdin',
        '--yes',
      ],
      `${PASSWORD}\n`,
    );
    expect(create.stdout).not.toContain(PASSWORD);
    expect(create.stderr).not.toContain(PASSWORD);
    expect(create.stdout).not.toContain('argon2');

    const userId = parseReport(create).user_id as string;
    const audit = await auditRows(pool, userId);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('argon2');
    expect(serialized).not.toMatch(/password_hash/);

    const stored = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE user_id = $1',
      [userId],
    );
    expect(stored.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.rows[0]?.password_hash).not.toContain(PASSWORD);
  });

  it('never accepts the password through argv or the environment', async () => {
    const viaArgv = await runCli(
      [
        'create',
        '--email',
        EMAIL,
        '--display-name',
        'Acceptance Operator',
        '--organization',
        BOOTSTRAP_ORGANIZATION_ID,
        `--password=${PASSWORD}`,
      ],
      null,
    );
    expect(viaArgv.code).toBe(1);
    expect(parseError(viaArgv).code).toBe('password_in_argv');

    const viaEnvironment = await runCli(
      ['set-password', '--email', EMAIL, '--password-stdin', '--yes'],
      `${PASSWORD}\n`,
      { OPERATOR_PASSWORD: PASSWORD },
    );
    expect(viaEnvironment.code).toBe(1);
    expect(parseError(viaEnvironment).code).toBe('password_in_environment');

    // The supported invocation carries no password in its own argv.
    const supported = [
      'create',
      '--email',
      EMAIL,
      '--display-name',
      'Acceptance Operator',
      '--organization',
      BOOTSTRAP_ORGANIZATION_ID,
      '--password-stdin',
      '--yes',
    ];
    expect(supported.join(' ')).not.toContain(PASSWORD);
  });

  it('fails closed on malformed stdin and on a non-interactive run without --password-stdin', async () => {
    const base = [
      'create',
      '--email',
      EMAIL,
      '--display-name',
      'Acceptance Operator',
      '--organization',
      BOOTSTRAP_ORGANIZATION_ID,
      '--yes',
    ];

    const withoutFlag = await runCli(base, null);
    expect(withoutFlag.code).toBe(1);
    expect(parseError(withoutFlag).code).toBe('password_required');

    const empty = await runCli([...base, '--password-stdin'], '\n');
    expect(empty.code).toBe(1);
    expect(parseError(empty).code).toBe('empty_password');

    const multiline = await runCli([...base, '--password-stdin'], `${PASSWORD}\nsecond-line\n`);
    expect(multiline.code).toBe(1);
    expect(parseError(multiline).code).toBe('malformed_password');

    const tooShort = await runCli([...base, '--password-stdin'], 'short\n');
    expect(tooShort.code).toBe(1);
    expect(parseError(tooShort).code).toBe('weak_password');

    const absent = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM users WHERE normalized_email = $1',
      [normalizeEmail(EMAIL)],
    );
    expect(absent.rows[0]?.count, 'no operator may exist after a failed run').toBe('0');
  });

  it('requires explicit confirmation for every access-changing operation', async () => {
    await createAcceptanceOperator();
    const unconfirmed = await runCli(['disable', '--email', EMAIL]);
    expect(unconfirmed.code).toBe(1);
    expect(parseError(unconfirmed).code).toBe('confirmation_required');

    const stillEnabled = await pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM users WHERE normalized_email = $1',
      [normalizeEmail(EMAIL)],
    );
    expect(stillEnabled.rows[0]?.enabled).toBe(true);
  });

  it('prints usage without touching the database', async () => {
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('operator revoke-sessions');
    expect(help.stdout).toContain('never read from argv or the environment');
    expect(help.stderr).toBe('');
  });

  it('keeps sessions when explicitly told to', async () => {
    await createAcceptanceOperator();
    const user = await authenticatePassword(pool, config, {
      email: EMAIL,
      password: PASSWORD,
      sourceAddress: '127.0.0.1',
    });
    const session = await createSession(pool, config, {
      user: user!,
      sourceAddress: '127.0.0.1',
      userAgent: 'vitest',
    });

    const reset = await runCli(
      ['set-password', '--email', EMAIL, '--keep-sessions', '--password-stdin', '--yes'],
      `${REPLACEMENT}\n`,
    );
    expect(reset.code, reset.stderr).toBe(0);
    expect(parseReport(reset).sessions_revoked).toBe(0);
    expect(await resolveSession(pool, config, session.token)).not.toBeNull();
  });
});
