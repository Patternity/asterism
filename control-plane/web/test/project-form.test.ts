/**
 * The rules the form applies before anything is sent.
 *
 * None of this is a security boundary — the server validates everything again —
 * but a form that lets an operator submit a URL with a password in it has
 * already put the password somewhere it will be written down.
 */
import { describe, expect, it } from 'vitest';

import {
  buildCreatePayload,
  failureMessage,
  isSettling,
  nodeIsSelectable,
  nodeUnavailableReason,
  stateSummary,
  suggestSlug,
  validate,
  type FormValues,
} from '../src/project-form';
import type { NodeRecord } from '../src/types';

const MODES = ['empty', 'clone'];

function values(overrides: Partial<FormValues> = {}): FormValues {
  return {
    name: 'Example project',
    slug: 'example-project',
    nodeId: 'node-1',
    mode: 'empty',
    repositoryUrl: '',
    branch: '',
    ...overrides,
  };
}

function node(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    node_id: 'node-1',
    display_name: 'Node one',
    connection_state: 'online',
    last_seen_at: null,
    software_version: null,
    protocol_version: 1,
    identity_generation: 1,
    fingerprint: 'f'.repeat(64),
    capabilities: {},
    node_capabilities: {
      connection_status: 'online',
      capabilities_known: true,
      run_approval_policy: [],
      supports_run_approval_policy: false,
      run_approval_policy_available: false,
      run_attachments: [],
      image_attachments_available: false,
      supports_project_provisioning: true,
      project_provisioning_available: true,
      workspace_modes: ['empty', 'clone'],
    },
    draining: false,
    revoked_at: null,
    ...overrides,
  } as NodeRecord;
}

describe('choosing a Node', () => {
  it('accepts one that is online and says it can build projects', () => {
    expect(nodeIsSelectable(node())).toBe(true);
    expect(nodeUnavailableReason(node())).toBeNull();
  });

  it('refuses an unreachable Node with a reason a person can act on', () => {
    const offline = node({
      connection_state: 'offline',
      node_capabilities: {
        ...node().node_capabilities!,
        connection_status: 'offline',
        project_provisioning_available: false,
      },
    });
    expect(nodeIsSelectable(offline)).toBe(false);
    expect(nodeUnavailableReason(offline)).toMatch(/offline|not connected|unreachable/i);
  });

  it('refuses a Node whose build never mentions project provisioning', () => {
    // Read from the advertisement, never from a version number: a Node that
    // cannot do this must be unselectable even when it is perfectly reachable.
    const legacy = node({
      node_capabilities: {
        ...node().node_capabilities!,
        supports_project_provisioning: false,
        project_provisioning_available: false,
        workspace_modes: [],
      },
    });
    expect(nodeIsSelectable(legacy)).toBe(false);
    expect(nodeUnavailableReason(legacy)).toMatch(/support|older|cannot/i);
  });
});

describe('what the form refuses to send', () => {
  it('accepts a complete empty-mode form', () => {
    expect(validate(values(), MODES)).toEqual({});
  });

  it('requires a name and a syntactically valid slug', () => {
    expect(validate(values({ name: '' }), MODES).name).toBeTruthy();
    expect(validate(values({ slug: 'Not A Slug' }), MODES).slug).toBeTruthy();
    expect(validate(values({ slug: '' }), MODES).slug).toBeTruthy();
  });

  it('requires a repository only in clone mode', () => {
    expect(validate(values({ mode: 'clone' }), MODES).repositoryUrl).toBeTruthy();
    expect(validate(values({ mode: 'empty', repositoryUrl: '' }), MODES).repositoryUrl).toBeFalsy();
  });

  it('refuses a repository URL carrying a credential instead of quietly removing it', () => {
    const errors = validate(
      values({ mode: 'clone', repositoryUrl: 'https://user:secret@example.com/a/b.git' }),
      MODES,
    );
    // Rejected and explained. Stripping the password would teach the operator
    // that pasting one is fine.
    expect(errors.repositoryUrl).toMatch(/credential|password|token/i);
  });

  it('refuses a branch that would become an option', () => {
    const errors = validate(
      values({ mode: 'clone', repositoryUrl: 'https://example.com/a/b.git', branch: '-b' }),
      MODES,
    );
    expect(errors.branch).toBeTruthy();
  });

  it('refuses a workspace mode the selected Node does not advertise', () => {
    expect(validate(values({ mode: 'clone' }), ['empty']).mode).toBeTruthy();
  });

  it('requires a Node to be chosen', () => {
    expect(validate(values({ nodeId: '' }), MODES).nodeId).toBeTruthy();
  });
});

describe('the payload that leaves the browser', () => {
  it('sends only the empty intent for an empty project', () => {
    const payload = buildCreatePayload(values());
    expect(payload).toEqual({
      name: 'Example project',
      slug: 'example-project',
      node_id: 'node-1',
      workspace: { mode: 'empty' },
    });
  });

  it('sends the repository and branch for a clone', () => {
    const payload = buildCreatePayload(
      values({ mode: 'clone', repositoryUrl: 'https://example.com/a/b.git', branch: 'main' }),
    );
    expect(payload.workspace).toEqual({
      mode: 'clone',
      repository_url: 'https://example.com/a/b.git',
      branch: 'main',
    });
  });

  it('omits an empty branch rather than sending a blank one', () => {
    const payload = buildCreatePayload(
      values({ mode: 'clone', repositoryUrl: 'https://example.com/a/b.git', branch: '   ' }),
    );
    expect(payload.workspace).toEqual({
      mode: 'clone',
      repository_url: 'https://example.com/a/b.git',
    });
  });

  it('drops repository fields when the operator switches back to an empty project', () => {
    // The fields are only hidden in the DOM; a payload built from the whole
    // form would still carry the repository the operator changed their mind
    // about, and the server would clone it.
    const payload = buildCreatePayload(
      values({ mode: 'empty', repositoryUrl: 'https://example.com/a/b.git', branch: 'main' }),
    );
    expect(payload.workspace).toEqual({ mode: 'empty' });
    expect(JSON.stringify(payload)).not.toContain('example.com');
  });
});

describe('suggesting a slug', () => {
  it('offers a conservative ASCII suggestion the operator can correct', () => {
    expect(suggestSlug('Example Project')).toBe('example-project');
    expect(suggestSlug('  Spaces   and---dashes  ')).toBe('spaces-and-dashes');
    expect(suggestSlug('Trailing!!!')).toBe('trailing');
  });

  it('gives back nothing rather than an invalid guess', () => {
    // A name with no ASCII letters produces no suggestion at all: an empty
    // field an operator must fill is honest, a slug like `---` is not.
    expect(suggestSlug('!!!')).toBe('');
  });
});

describe('explaining a failure', () => {
  it('speaks about the situation, not the internals', () => {
    const message = failureMessage('repository_authentication_unavailable');
    expect(message).toMatch(/credential|access|authenticat/i);
    for (const leak of ['/var/lib', 'systemd', 'stderr', 'HERMES_HOME', '18642']) {
      expect(message).not.toContain(leak);
    }
  });

  it('is chosen by code and never by matching English', () => {
    expect(failureMessage('project_slug_conflict')).not.toBe(
      failureMessage('repository_clone_failed'),
    );
  });

  it('stays safe for a code this build has never heard of', () => {
    const message = failureMessage('something_invented_later');
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('something_invented_later');
  });
});

describe('which states are still moving', () => {
  it('polls only while the answer can still change', () => {
    expect(isSettling('pending')).toBe(true);
    expect(isSettling('provisioning')).toBe(true);
    for (const settled of ['ready', 'failed', 'disabled'] as const) {
      expect(isSettling(settled)).toBe(false);
    }
  });

  it('describes each state without naming anything on the host', () => {
    for (const state of ['pending', 'provisioning', 'ready', 'failed', 'disabled'] as const) {
      const summary = stateSummary(state);
      expect(summary.length).toBeGreaterThan(0);
      for (const leak of ['/var/lib', 'systemd', 'HERMES_HOME', '18642', 'api_key']) {
        expect(summary).not.toContain(leak);
      }
    }
  });
});
