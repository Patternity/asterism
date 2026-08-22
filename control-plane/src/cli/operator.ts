/**
 * Local operator administration.
 *
 * Run this inside the Control Plane environment, on the host that owns the
 * database. It is the recovery path for a deployment whose operators can no
 * longer sign in, and the way to mint a short-lived account for acceptance
 * work. There is no HTTP endpoint and no remote command behind it: reaching
 * this CLI already means holding the server.
 *
 *   operator create --email <e> --display-name <n> --organization <id|slug>
 *                   [--role developer] [--project <id>]
 *   operator set-password --email <e> [--keep-sessions]
 *   operator disable --email <e>
 *   operator enable --email <e>
 *   operator revoke-sessions --email <e>
 *
 * The password never travels through argv or the environment, where it would be
 * visible to every other process on the host through `/proc` and would outlive
 * the command in shell history. It is typed at a hidden prompt — twice, so a
 * typo cannot silently lock an account out — or piped explicitly with
 * `--password-stdin`. A non-interactive run that offers neither fails closed
 * rather than inventing a password.
 *
 * Only `DATABASE_URL` is read, not the full server configuration: recovery must
 * still work on a deployment whose Control Plane refuses to start.
 */
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

import { normalizeEmail } from '../auth.js';
import { createPool } from '../db.js';
import {
  createOperator,
  LEAST_CHAT_ROLE,
  OperatorAdminError,
  type OperatorSummary,
  requireRole,
  revokeOperatorSessions,
  setOperatorEnabled,
  setOperatorPassword,
} from '../operator-admin.js';

const ACTIONS = ['create', 'set-password', 'disable', 'enable', 'revoke-sessions'] as const;
type Action = (typeof ACTIONS)[number];

/** Ctrl-C and backspace, as raw-mode input delivers them. */
const END_OF_TEXT = '\u0003';
const BACKSPACE = '\u007f';

/**
 * Environment names that would mean "here is the operator password".
 *
 * Refusing loudly is the point. Ignoring one would let an operator believe a
 * scripted invocation had honoured their variable, and then wonder which
 * password the account actually carries.
 */
const FORBIDDEN_PASSWORD_ENVIRONMENT = [
  'ASTERISM_OPERATOR_PASSWORD',
  'ASTERISM_PASSWORD',
  'OPERATOR_PASSWORD',
];

class UsageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UsageError';
    this.code = code;
  }
}

interface Options {
  action: Action;
  email: string;
  displayName?: string;
  organization?: string;
  role?: string;
  projectId?: string;
  passwordStdin: boolean;
  keepSessions: boolean;
  assumeYes: boolean;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError('missing_value', `${name} requires a value`);
  }
  return value;
}

const USAGE = `Local operator administration for the Asterism Control Plane.

Usage:
  operator create --email <address> --display-name <name> --organization <id|slug>
                  [--role owner|admin|developer|viewer] [--project <project_id>]
  operator set-password   --email <address> [--keep-sessions]
  operator disable        --email <address>
  operator enable         --email <address>
  operator revoke-sessions --email <address>

Options:
  --password-stdin  read the password from stdin instead of a hidden prompt
  --yes             confirm non-interactively; required with --password-stdin
  --organization    disambiguate an operator who belongs to several organizations

The password is never read from argv or the environment. Requires DATABASE_URL.
`;

/** Requests for help are not failures; they belong on stdout with exit 0. */
function isHelpRequest(argv: string[]): boolean {
  return argv.length === 0 || argv.some((item) => item === '--help' || item === '-h');
}

function parse(argv: string[]): Options {
  const action = argv[0];
  if (!action || !ACTIONS.includes(action as Action)) {
    throw new UsageError('unknown_action', `action must be one of ${ACTIONS.join(', ')}`);
  }

  // A password on the command line is visible in `ps` and lands in shell
  // history. Refuse rather than quietly ignore it.
  if (argv.some((item) => item === '--password' || item.startsWith('--password='))) {
    throw new UsageError(
      'password_in_argv',
      'a password must not be passed on the command line; use --password-stdin or the prompt',
    );
  }
  const environmentName = FORBIDDEN_PASSWORD_ENVIRONMENT.find((name) => process.env[name]);
  if (environmentName) {
    throw new UsageError(
      'password_in_environment',
      `${environmentName} is set; a password must not be passed through the environment`,
    );
  }

  const email = option(argv, '--email');
  if (!email) throw new UsageError('missing_option', '--email is required');

  return {
    action: action as Action,
    email,
    displayName: option(argv, '--display-name'),
    organization: option(argv, '--organization'),
    role: option(argv, '--role'),
    projectId: option(argv, '--project'),
    passwordStdin: flag(argv, '--password-stdin'),
    keepSessions: flag(argv, '--keep-sessions'),
    assumeYes: flag(argv, '--yes'),
  };
}

/** Read one line from the terminal without echoing it. */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (key: string): void => {
      for (const character of key) {
        if (character === '\r' || character === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (character === END_OF_TEXT) {
          finish();
          reject(new UsageError('cancelled', 'cancelled'));
          return;
        }
        if (character === BACKSPACE) value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

function promptVisible(label: string): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    reader.question(label, (answer) => {
      reader.close();
      resolve(answer.trim());
    });
  });
}

async function readAllStdin(): Promise<string> {
  let value = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) value += String(chunk);
  return value;
}

/**
 * Obtain the new password.
 *
 * `--password-stdin` takes the whole of stdin minus one trailing newline. A
 * password with an interior newline or a NUL byte is malformed rather than
 * truncated: silently keeping the first line would set a password the operator
 * did not intend and could not reproduce.
 */
async function obtainPassword(options: Options): Promise<string> {
  if (options.passwordStdin) {
    const value = (await readAllStdin()).replace(/\r?\n$/, '');
    if (!value) {
      throw new UsageError('empty_password', '--password-stdin received no password');
    }
    if (/[\r\n\0]/.test(value)) {
      throw new UsageError(
        'malformed_password',
        'a password read from stdin must be a single line without NUL bytes',
      );
    }
    return value;
  }
  if (!stdin.isTTY) {
    throw new UsageError(
      'password_required',
      'no terminal to prompt on; pass --password-stdin to supply the password',
    );
  }
  const first = await promptHidden('New password: ');
  const second = await promptHidden('Repeat password: ');
  if (first !== second) {
    throw new UsageError('password_mismatch', 'the two passwords did not match');
  }
  return first;
}

/**
 * Confirm an operation that changes who can sign in.
 *
 * Every action here grants, removes, or takes over access, so all of them ask.
 * `--password-stdin` has already consumed stdin, which leaves no channel for an
 * interactive answer; those runs must say `--yes` explicitly.
 */
async function confirm(options: Options): Promise<void> {
  if (options.assumeYes) return;
  if (options.passwordStdin || !stdin.isTTY) {
    throw new UsageError(
      'confirmation_required',
      'this operation changes account access; pass --yes to confirm non-interactively',
    );
  }
  const expected = normalizeEmail(options.email);
  const answer = await promptVisible(
    `About to ${options.action} ${expected}. Type the email to confirm: `,
  );
  if (normalizeEmail(answer) !== expected) {
    throw new UsageError('not_confirmed', 'confirmation did not match; nothing was changed');
  }
}

function report(action: Action, summary: OperatorSummary): void {
  stdout.write(
    `${JSON.stringify({
      action: `operator.${action.replace('-', '_')}`,
      result: 'ok',
      user_id: summary.userId,
      email: summary.email,
      organization_id: summary.organizationId,
      ...(summary.role ? { role: summary.role } : {}),
      ...(summary.projectId ? { project_id: summary.projectId } : {}),
      enabled: summary.enabled,
      ...(summary.sessionsRevoked === undefined
        ? {}
        : { sessions_revoked: summary.sessionsRevoked }),
    })}\n`,
  );
}

async function run(options: Options): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new UsageError('missing_database_url', 'DATABASE_URL is required');
  const pool = createPool(databaseUrl, 2);
  try {
    switch (options.action) {
      case 'create': {
        const { displayName, organization } = options;
        if (!displayName) throw new UsageError('missing_option', '--display-name is required');
        if (!organization) throw new UsageError('missing_option', '--organization is required');
        const role = requireRole(options.role ?? LEAST_CHAT_ROLE);
        const password = await obtainPassword(options);
        await confirm(options);
        report(
          'create',
          await createOperator(pool, {
            email: options.email,
            displayName,
            password,
            organization,
            role,
            projectId: options.projectId,
          }),
        );
        return;
      }
      case 'set-password': {
        const password = await obtainPassword(options);
        await confirm(options);
        report(
          'set-password',
          await setOperatorPassword(pool, {
            email: options.email,
            password,
            keepSessions: options.keepSessions,
            organization: options.organization,
          }),
        );
        return;
      }
      case 'disable':
      case 'enable': {
        await confirm(options);
        report(
          options.action,
          await setOperatorEnabled(pool, {
            email: options.email,
            enabled: options.action === 'enable',
            organization: options.organization,
          }),
        );
        return;
      }
      case 'revoke-sessions': {
        await confirm(options);
        report(
          'revoke-sessions',
          await revokeOperatorSessions(pool, {
            email: options.email,
            organization: options.organization,
          }),
        );
        return;
      }
    }
  } finally {
    await pool.end();
  }
}

/**
 * Parsing happens inside the async entry point on purpose: a synchronous throw
 * here would escape the promise chain and surface as an unhandled exception
 * with a stack trace, instead of the typed one-line refusal every other failure
 * produces.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    stdout.write(USAGE);
    return;
  }
  await run(parse(argv));
}

main().catch((error: unknown) => {
  const code =
    error instanceof OperatorAdminError || error instanceof UsageError ? error.code : 'failed';
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ action: 'operator', error: { code, message } })}\n`);
  process.exitCode = 1;
});
