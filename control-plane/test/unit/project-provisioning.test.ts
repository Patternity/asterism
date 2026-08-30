/**
 * The rules that decide what may be stored and what may run.
 *
 * These are the checks that stand between an operator's typing and a durable
 * row, and between a repository URL and an audit entry. Each case below is
 * something that would otherwise be written down and then have to be redacted.
 */
import { describe, expect, it } from 'vitest';

import {
  canCreateRuns,
  isCurrentGeneration,
  isRetryable,
  knownFailure,
  validateBranch,
  validateName,
  validateRepositoryUrl,
  validateSlug,
} from '../../src/project-provisioning.js';

describe('what may create a run', () => {
  it('accepts only a ready project', () => {
    expect(canCreateRuns('ready')).toBe(true);
    for (const state of ['pending', 'provisioning', 'failed', 'disabled', 'unknown']) {
      expect(canCreateRuns(state)).toBe(false);
    }
  });
});

describe('repository URLs', () => {
  it('accepts the forms git itself accepts', () => {
    for (const url of [
      'https://github.com/organization/repository.git',
      'ssh://git@github.com:22/organization/repository.git',
      'git@github.com:organization/repository.git',
    ]) {
      expect(validateRepositoryUrl(url), url).toMatchObject({ ok: true });
    }
  });

  it('refuses a credential rather than storing one to redact later', () => {
    // A URL reaches the project row, the audit trail and every rendering of the
    // project. A password in it is not a formatting problem.
    for (const url of [
      'https://user:secret@github.com/organization/repository.git',
      'https://github.com/org/repo.git?access_token=abc123',
      'ssh://user:pass@host/repo.git',
    ]) {
      expect(validateRepositoryUrl(url), url).toMatchObject({
        ok: false,
        reason: 'repository_credentials_embedded',
      });
    }
  });

  it('refuses whitespace, control characters and unknown shapes', () => {
    for (const url of [
      '',
      'not a url',
      'file:///etc/passwd',
      'https://github.com',
      'a'.repeat(513),
      'https://host/repo .git',
    ]) {
      expect(validateRepositoryUrl(url), JSON.stringify(url)).toMatchObject({ ok: false });
    }
  });
});

describe('branch names', () => {
  it('accepts an ordinary branch', () => {
    expect(validateBranch('main')).toEqual({ ok: true, branch: 'main' });
    expect(validateBranch('feature/some-work')).toEqual({ ok: true, branch: 'feature/some-work' });
  });

  it('refuses a name that would become an option', () => {
    // Argument-safe execution protects against the shell, not against git's own
    // parser: `--upload-pack=...` is still an option when passed as one argument.
    expect(validateBranch('--upload-pack=id')).toMatchObject({ ok: false });
    expect(validateBranch('-b')).toMatchObject({ ok: false });
  });

  it('refuses names git itself rejects', () => {
    for (const branch of ['', 'a..b', 'ends/', 'thing.lock', 'has space', 'star*']) {
      expect(validateBranch(branch), branch).toMatchObject({ ok: false });
    }
  });
});

describe('names and slugs', () => {
  it('accepts a plain slug and refuses shapes that are not identifiers', () => {
    expect(validateSlug('example-project')).toEqual({ ok: true, slug: 'example-project' });
    for (const slug of [
      'a',
      'Has-Upper',
      'trailing-',
      '-leading',
      'double--dash',
      'has space',
      '../etc',
    ]) {
      expect(validateSlug(slug), slug).toMatchObject({ ok: false });
    }
  });

  it('refuses a control character in a display name', () => {
    expect(validateName('Example')).toEqual({ ok: true, name: 'Example' });
    expect(validateName('Example\u0007')).toMatchObject({ ok: false });
    expect(validateName('')).toMatchObject({ ok: false });
  });
});

describe('failure codes', () => {
  it('drops a code this build does not know', () => {
    expect(knownFailure('repository_clone_failed')).toBe('repository_clone_failed');
    expect(knownFailure('something_new')).toBeNull();
    expect(knownFailure(7)).toBeNull();
  });

  it('offers retry only where retrying could differ', () => {
    expect(isRetryable('repository_clone_failed')).toBe(true);
    expect(isRetryable('profile_worker_unhealthy')).toBe(true);
    // A conflicting slug and a refused capability fail identically forever; a
    // retry button on those teaches an operator to click uselessly.
    expect(isRetryable('project_slug_conflict')).toBe(false);
    expect(isRetryable('node_capability_unavailable')).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});

describe('provisioning generation', () => {
  it('accepts only the attempt currently in flight', () => {
    expect(isCurrentGeneration(2, 2)).toBe(true);
    // A Node reconnecting mid-provisioning can deliver the result of an attempt
    // the operator has already retried past.
    expect(isCurrentGeneration(2, 1)).toBe(false);
    expect(isCurrentGeneration(2, 3)).toBe(false);
    expect(isCurrentGeneration(2, '2')).toBe(false);
    expect(isCurrentGeneration(2, undefined)).toBe(false);
  });
});
