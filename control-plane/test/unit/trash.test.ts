/**
 * Whether something is in Trash, decided from two tombstones.
 *
 * A project's own and its Node's. The rule is simple and the failures it
 * prevents are not: a check that looked only at the project would let work
 * through for every project on a Node somebody had just put in Trash.
 */
import { describe, expect, it } from 'vitest';

import { projectIsActive, projectTrashView, trashRefusalOf } from '../../src/trash.js';

const at = new Date('2026-09-22T10:00:00Z');
const project = (trashed_at: Date | null) => ({
  trashed_at,
  trashed_by_user_id: trashed_at ? 'user-1' : null,
  worker_lifecycle: null,
  worker_lifecycle_failure: null,
});

describe('a project is in Trash through either tombstone', () => {
  const cases: [string, Date | null, Date | null, boolean, boolean, boolean][] = [
    // label, own, node, trashed, inherited, effective
    ['neither', null, null, false, false, false],
    ['its own only', at, null, true, false, true],
    ['its Node only', null, at, false, true, true],
    ['both', at, at, true, true, true],
  ];
  for (const [label, own, node, trashed, inherited, effective] of cases) {
    it(label, () => {
      const view = projectTrashView(project(own), { trashed_at: node });
      expect(view).toMatchObject({ trashed, inherited, effective });
      expect(projectIsActive(project(own), { trashed_at: node })).toBe(!effective);
    });
  }

  it('keeps an independent tombstone distinguishable from an inherited one', () => {
    const inherited = projectTrashView(project(null), { trashed_at: at });
    expect(inherited.trashed_at).toBeNull();
    expect(inherited.node_trashed_at).toBe(at.toISOString());
  });
});

describe("the database's refusals", () => {
  it('are read as the typed refusal they stand for, and nothing else is', () => {
    expect(trashRefusalOf({ code: 'TR001' })).toBe('node_trashed');
    expect(trashRefusalOf({ code: 'TR002' })).toBe('project_trashed');
    expect(trashRefusalOf({ code: '23505' })).toBeNull();
    expect(trashRefusalOf(new Error('x'))).toBeNull();
    expect(trashRefusalOf(null)).toBeNull();
  });
});
