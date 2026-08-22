/**
 * Audit a resolved Docker Compose configuration before it is deployed.
 *
 * Reads `docker compose config --format json` on stdin so the check runs
 * against exactly what Compose will apply — overlays merged, variables
 * interpolated — rather than against what the files appear to say.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.production.yml \
 *     config --format json | npm run check:production
 */
import { stdin, stdout } from 'node:process';

import { auditProductionConfiguration, type ComposeConfiguration } from '../production-config.js';

async function readAllStdin(): Promise<string> {
  let value = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) value += String(chunk);
  return value;
}

async function main(): Promise<void> {
  const raw = await readAllStdin();
  if (!raw.trim()) {
    throw new Error('no Compose configuration on stdin');
  }
  let configuration: ComposeConfiguration;
  try {
    configuration = JSON.parse(raw) as ComposeConfiguration;
  } catch {
    throw new Error('stdin is not the JSON output of `docker compose config --format json`');
  }

  const problems = auditProductionConfiguration(configuration);
  if (problems.length === 0) {
    stdout.write(`${JSON.stringify({ check: 'production-config', result: 'ok' })}\n`);
    return;
  }
  for (const problem of problems) {
    stdout.write(`  ${problem.check.padEnd(24)} ${problem.message}\n`);
  }
  stdout.write(`REFUSED: ${problems.length} production configuration problem(s)\n`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
