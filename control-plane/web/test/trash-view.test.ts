import { describe, expect, it } from 'vitest';

import {
  TRASH_NODE_CONFIRMATION,
  TRASH_PROJECT_CONFIRMATION,
  projectRestore,
  projectTrashReason,
  workerLabel,
  workerTone,
  type ProjectTrash,
} from '../src/trash-view';

const trash = (overrides: Partial<ProjectTrash>): ProjectTrash => ({
  trashed: false,
  inherited: false,
  effective: false,
  trashed_at: null,
  worker: null,
  ...overrides,
});

describe('restore is offered where it means something', () => {
  it('on a project in Trash on its own under an active Node', () => {
    expect(projectRestore(trash({ trashed: true, effective: true }))).toEqual({ offered: true });
  });

  it('not on a project in Trash through its Node, and it says why', () => {
    for (const own of [true, false]) {
      const decision = projectRestore(trash({ trashed: own, inherited: true, effective: true }));
      expect(decision).toEqual({ offered: false, reason: 'Restore its Node first.' });
    }
  });

  it('not on a project that is not in Trash', () => {
    expect(projectRestore(trash({}))).toEqual({ offered: false, reason: '' });
  });
});

describe('why a project is in Trash', () => {
  it('distinguishes its own tombstone from its Node', () => {
    expect(projectTrashReason(trash({ trashed: true }))).toBe('In Trash on its own.');
    expect(projectTrashReason(trash({ inherited: true }))).toBe('In Trash with its Node.');
    // The case that matters when the Node comes back.
    expect(projectTrashReason(trash({ trashed: true, inherited: true }))).toMatch(
      /stays in Trash when the Node is restored/,
    );
  });
});

describe('what happened to a worker', () => {
  it('never claims a host change nobody made', () => {
    expect(workerLabel('not_managed')).toMatch(/nothing on the host was changed/);
    expect(workerLabel('unsupported')).toMatch(/nothing on the host was changed/);
  });

  it('says when it is still on its way, and when it failed', () => {
    expect(workerLabel('stopping')).toMatch(/waiting for the Node/);
    expect(workerLabel('starting')).toMatch(/waiting for the Node/);
    expect(workerTone('stop_failed')).toBe('fail');
    expect(workerTone('start_failed')).toBe('fail');
    expect(workerTone('stopping')).toBe('warn');
    expect(workerTone('stopped')).toBe('ok');
    expect(workerLabel(null)).toBe('');
  });
});

describe('what a person is told before moving anything', () => {
  for (const [what, text] of [
    ['a project', TRASH_PROJECT_CONFIRMATION],
    ['a Node', TRASH_NODE_CONFIRMATION],
  ] as const) {
    it(`states all four facts for ${what}`, () => {
      expect(text).toMatch(/disappear from/);
      expect(text).toMatch(/kept/);
      expect(text).toMatch(/restore it from Trash/);
      expect(text).toMatch(/no disk space is freed/);
    });
  }
});
