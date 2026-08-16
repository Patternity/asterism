import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveMigrationsDir } from '../../src/db.js';

/**
 * The published image compiles `src/db.ts` to `dist/src/db.js`, one directory
 * deeper than the source. Resolving the migrations at a fixed depth therefore
 * worked in development and pointed at an empty `dist/migrations` in the image,
 * so `docker compose up` failed at the migration step and the Control Plane
 * never started. These tests pin the layout-independent behaviour.
 */
describe('migrations directory resolution', () => {
  async function packageRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'asterism-migrations-'));
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
    await mkdir(path.join(root, 'migrations'), { recursive: true });
    return root;
  }

  it('finds the migrations from the source layout', async () => {
    const root = await packageRoot();
    await mkdir(path.join(root, 'src'), { recursive: true });
    expect(resolveMigrationsDir(path.join(root, 'src'))).toBe(path.join(root, 'migrations'));
  });

  it('finds the migrations from the compiled layout', async () => {
    const root = await packageRoot();
    await mkdir(path.join(root, 'dist', 'src'), { recursive: true });
    expect(resolveMigrationsDir(path.join(root, 'dist', 'src'))).toBe(
      path.join(root, 'migrations'),
    );
  });

  it('finds the same directory from any depth below the package root', async () => {
    const root = await packageRoot();
    const deep = path.join(root, 'dist', 'src', 'cli', 'nested');
    await mkdir(deep, { recursive: true });
    expect(resolveMigrationsDir(deep)).toBe(path.join(root, 'migrations'));
  });

  it('fails loudly when there is no package root above the start directory', async () => {
    const orphan = await mkdtemp(path.join(tmpdir(), 'asterism-orphan-'));
    // A silent fallback here would reintroduce the original defect in a new
    // shape: a wrong directory that only fails once a deployment is live.
    expect(() => resolveMigrationsDir(orphan)).toThrow(/cannot locate the package root/);
  });

  it('resolves the real repository migrations for this build', async () => {
    const resolved = resolveMigrationsDir(path.dirname(new URL(import.meta.url).pathname));
    expect(resolved.endsWith(path.join('control-plane', 'migrations'))).toBe(true);
  });
});
