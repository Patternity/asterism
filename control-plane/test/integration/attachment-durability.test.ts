/**
 * Attachments must survive a browser reload.
 *
 * The console reconstructs a conversation from `GET /projects/:id/chat`, and an
 * attachment can only reappear there if run creation recorded it on the run
 * row. The command payload that carries the image to the Node is not part of
 * that view, so a run whose metadata omits the attachment renders the image
 * once and then loses it on refresh — which is what happened until the run row
 * started carrying its own copy.
 *
 * These tests go through the real HTTP surface against a real database, because
 * that is the boundary where the omission was invisible: a mocked backend can
 * return whatever shape the component wants.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import { createInitialOwner } from '../../src/auth.js';
import { nodesRepo, projectsRepo } from '../../src/repositories.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';

const IMAGE = { type: 'image_url', url: 'https://example.test/diagram.png', alt: 'a diagram' };

describe('attachment durability across a reload', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let config: Config;
  let channel: NodeChannel;

  beforeAll(async () => {
    config = loadConfig({
      DATABASE_URL,
      PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
      ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
      ALLOW_PLAINTEXT: 'true',
      OPERATOR_COMPATIBILITY: 'false',
      NODE_ENV: 'development',
    });
    pool = createPool(DATABASE_URL, 4);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool.end();
  });

  beforeEach(async () => {
    await app?.close();
    await rollbackAll(pool);
    await migrate(pool);
    channel = new NodeChannel(pool, createLogger('silent'), config);
    app = await buildApp({ pool, config, logger: createLogger('silent'), channel });
    await app.ready();
  }, 60_000);

  /** A project whose Node is online and advertises image attachments. */
  async function onlineProject() {
    const node = await nodesRepo.create(pool, {
      nodeId: 'node-attachments',
      displayName: 'Attachment Node',
      publicKey: 'attachments',
      fingerprint: 'a'.repeat(64),
      organizationId: 'org_bootstrap',
    });
    await pool.query(
      `UPDATE nodes SET connection_state = 'online',
                        capabilities = $2::jsonb
       WHERE node_id = $1`,
      [
        node.node_id,
        JSON.stringify({
          attachments: { run_attachments: ['image_url'], max_per_message: 4 },
        }),
      ],
    );
    const project = await projectsRepo.upsert(pool, {
      nodeId: node.node_id,
      nodeProjectId: 'project-attachments',
      displayName: 'Attachment Project',
      enabled: true,
      metadata: { runtime_state: 'ready' },
    });
    return { node, project };
  }

  async function signIn() {
    await createInitialOwner(pool, {
      email: 'owner@example.com',
      displayName: 'Owner',
      password: 'correct-horse-battery',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:8080' },
      payload: { email: 'owner@example.com', password: 'correct-horse-battery' },
    });
    const cookies = response.cookies as { name: string; value: string }[];
    const session = cookies.find((cookie) => cookie.name === 'asterism_session')!.value;
    const csrf = cookies.find((cookie) => cookie.name === 'asterism_csrf')!.value;
    return {
      cookie: `asterism_session=${session}; asterism_csrf=${csrf}`,
      csrf,
    };
  }

  function headers(auth: { cookie: string; csrf: string }) {
    return {
      cookie: auth.cookie,
      'x-csrf-token': auth.csrf,
      origin: 'http://127.0.0.1:8080',
    };
  }

  it('returns the attachment in the conversation the browser rebuilds', async () => {
    const auth = await signIn();
    const { project } = await onlineProject();
    const sessionId = 'session-with-an-image';

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.project_id}/runs`,
      headers: headers(auth),
      payload: { input: 'What is in this image?', session_id: sessionId, attachments: [IMAGE] },
    });
    expect(created.statusCode).toBe(201);
    expect(
      created.json().run.request_metadata.attachments,
      'the run row must carry its own copy',
    ).toEqual([IMAGE]);

    const chat = await app.inject({
      url: `/api/v1/projects/${project.project_id}/chat`,
      headers: headers(auth),
    });
    expect(chat.statusCode).toBe(200);
    const runs = chat.json().runs as { request_metadata: { attachments?: unknown[] } }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]!.request_metadata.attachments).toEqual([IMAGE]);
  });

  it('leaves a turn without attachments exactly as it was', async () => {
    const auth = await signIn();
    const { project } = await onlineProject();

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.project_id}/runs`,
      headers: headers(auth),
      payload: { input: 'No image here', session_id: 'plain-session' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().run.request_metadata).toEqual({
      input_length: 'No image here'.length,
      session_id: 'plain-session',
    });
  });

  it('carries the attachment onto a retry without duplicating the turn', async () => {
    const auth = await signIn();
    const { project } = await onlineProject();

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.project_id}/runs`,
      headers: headers(auth),
      payload: { input: 'Read this image', session_id: 'retry-session', attachments: [IMAGE] },
    });
    const runId = created.json().run.run_id as string;
    await pool.query(
      `UPDATE runs SET node_run_id = 'arun-retry', status = 'interrupted' WHERE run_id = $1`,
      [runId],
    );

    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/retry`,
      headers: headers(auth),
      payload: {},
    });
    expect(retried.statusCode).toBe(202);
    const replacement = retried.json().run as {
      run_id: string;
      request_metadata: { attachments?: unknown[]; retry_of_run_id?: string };
    };
    expect(replacement.request_metadata.attachments).toEqual([IMAGE]);
    expect(replacement.request_metadata.retry_of_run_id).toBe(runId);

    const chat = await app.inject({
      url: `/api/v1/projects/${project.project_id}/chat`,
      headers: headers(auth),
    });
    const runs = chat.json().runs as { run_id: string }[];
    expect(runs.map((run) => run.run_id)).toEqual([runId, replacement.run_id]);
  });

  it('does not invent attachments for a run whose metadata predates the field', async () => {
    const auth = await signIn();
    const { project } = await onlineProject();
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.project_id}/runs`,
      headers: headers(auth),
      payload: { input: 'Older shape', session_id: 'legacy-session' },
    });
    const runId = created.json().run.run_id as string;
    await pool.query(
      `UPDATE runs SET request_metadata = '{"attachments": "not-an-array"}'::jsonb,
                       node_run_id = 'arun-legacy', status = 'interrupted'
       WHERE run_id = $1`,
      [runId],
    );

    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/retry`,
      headers: headers(auth),
      payload: {},
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().run.request_metadata.attachments).toBeUndefined();
  });
});
