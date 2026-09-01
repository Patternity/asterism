import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  bootstrapCommand,
  downloadDetail,
  failureExplanation,
  formatBytes,
  isTerminalState,
  stageLabel,
} from '../src/node-install';

/**
 * The Control Plane's own lists, read as text.
 *
 * Deliberately not imported. The console and the backend typecheck as separate
 * projects under different settings, and importing backend source into the
 * console build applies one project's rules to the other's code. Reading the
 * file still fails the moment a value is added on one side and not the other,
 * which is the whole point.
 */
function wireValues(constant: string): string[] {
  // Vitest runs from the console package, and the backend is its sibling.
  const source = readFileSync(resolve(process.cwd(), '../src/node-installations.ts'), 'utf8');
  const start = source.indexOf(`export const ${constant} = [`);
  if (start < 0) throw new Error(`${constant} is not defined by the Control Plane`);
  const body = source.slice(start, source.indexOf('] as const;', start));
  const values = [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string);
  // A parser that quietly returns nothing would make every check below pass
  // without checking anything.
  if (values.length === 0) throw new Error(`read no values out of ${constant}`);
  return values;
}

const INSTALLATION_STATES = wireValues('INSTALLATION_STATES');
const FAILURE_CODES = wireValues('FAILURE_CODES');

describe('stage labels', () => {
  it('has a sentence for every stage the Control Plane can report', () => {
    // The two lists are the same protocol. A stage added on the server and not
    // here would render as a raw identifier to whoever is watching.
    for (const state of INSTALLATION_STATES) {
      expect(stageLabel(state), state).not.toBe(state);
      expect(stageLabel(state).length, state).toBeGreaterThan(0);
    }
  });

  it('renders a stage it has never heard of rather than nothing', () => {
    // A console that silently omits what it does not recognise looks broken in
    // exactly the situation where a person most needs to know what is going on.
    expect(stageLabel('some_future_stage')).toBe('some future stage');
  });
});

describe('failure explanations', () => {
  it('explains every failure code the Control Plane can report', () => {
    for (const code of FAILURE_CODES) {
      const explanation = failureExplanation(code);
      expect(explanation, code).not.toContain('_');
      expect(explanation.length, code).toBeGreaterThan(10);
    }
  });

  it('still says something useful for a code it does not know', () => {
    expect(failureExplanation('brand_new_reason')).toContain('brand new reason');
  });

  it('says something rather than nothing when there is no code at all', () => {
    expect(failureExplanation(null).length).toBeGreaterThan(10);
  });
});

describe('terminal states', () => {
  it('agrees with the Control Plane about which stages are the end', () => {
    for (const state of ['complete', 'failed', 'cancelled', 'expired']) {
      expect(isTerminalState(state), state).toBe(true);
    }
    for (const state of INSTALLATION_STATES.filter(
      (value) => !['complete', 'failed', 'cancelled', 'expired'].includes(value),
    )) {
      expect(isTerminalState(state), state).toBe(false);
    }
  });
});

describe('byte counts', () => {
  it('reads the way a download is measured everywhere else', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_500)).toBe('1.5 kB');
    expect(formatBytes(550_000_000)).toBe('550 MB');
    expect(formatBytes(1_900_000_000)).toBe('1.9 GB');
  });

  it('shows nothing rather than a wrong number when there is no count', () => {
    expect(formatBytes(null)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });
});

describe('the download line', () => {
  it('appears only while bytes are actually moving', () => {
    expect(downloadDetail({ state: 'runtime_installing', bytes_done: 10, bytes_total: 100 })).toBe(
      '',
    );
    expect(
      downloadDetail({ state: 'bundle_downloading', bytes_done: 550_000, bytes_total: 1_100_000 }),
    ).toBe('550 kB of 1.1 MB');
  });

  it('shows what has arrived when the total is not known', () => {
    expect(
      downloadDetail({ state: 'bundle_downloading', bytes_done: 550_000, bytes_total: null }),
    ).toBe('550 kB');
  });
});

describe('the command a person runs', () => {
  it('never carries the connection code', () => {
    // A credential on a command line survives in shell history, in whatever the
    // person pasted it through, and in any screenshot of the terminal.
    const command = bootstrapCommand('https://asterism.example');
    expect(command).not.toMatch(/code/i);
    expect(command).toContain('ASTERISM_CONTROL_PLANE=https://asterism.example');
    expect(command).toContain('bootstrap.sh');
  });

  it('points at the Control Plane the person is actually looking at', () => {
    expect(bootstrapCommand('https://other.example')).toContain('https://other.example');
  });
});
