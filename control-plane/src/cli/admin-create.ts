import { stdin, stdout } from 'node:process';

import { createInitialOwner } from '../auth.js';
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../db.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readPassword(): Promise<string> {
  if (!stdin.isTTY) {
    let value = '';
    for await (const chunk of stdin) value += String(chunk);
    return value.replace(/[\r\n]+$/, '');
  }
  stdout.write('Password: ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(value);
    };
    stdin.on('data', (key: string) => {
      if (key === '\r' || key === '\n') return finish();
      if (key === '\u0003') {
        stdin.setRawMode(false);
        reject(new Error('cancelled'));
        return;
      }
      if (key === '\u007f') value = value.slice(0, -1);
      else if (key >= ' ') value += key;
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, 2);
  try {
    await migrate(pool);
    const owner = await createInitialOwner(pool, {
      email: argument('--email'),
      displayName: argument('--display-name'),
      password: await readPassword(),
    });
    stdout.write(
      `${JSON.stringify({ created: true, user_id: owner.userId, organization_id: owner.organizationId })}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ error: 'admin_create_failed', message: String(error) })}\n`,
  );
  process.exitCode = 1;
});
