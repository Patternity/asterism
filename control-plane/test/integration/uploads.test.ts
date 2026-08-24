/**
 * Uploading a local image and getting it to the model.
 *
 * These run against a real PostgreSQL and a real temporary storage directory,
 * because most of what can go wrong here is not logic: a rolled-back run that
 * leaves a file behind, an attachment readable from the wrong organization, a
 * capability URL that survives into an API response. None of that is visible to
 * a test that mocks the database and the disk.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import { buildApp } from '../../src/app.js';
import { hashPassword, SESSION_COOKIE } from '../../src/auth.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool, migrate, rollbackAll, type Pool } from '../../src/db.js';
import { createLogger } from '../../src/logger.js';
import { NodeChannel } from '../../src/node-channel.js';
import { nodesRepo, projectsRepo } from '../../src/repositories.js';
import { MEDIA_ROUTE_PREFIX, signAttachment } from '../../src/media-capability.js';
import { BOOTSTRAP_ORGANIZATION_ID } from '../../src/tenancy.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://asterism:asterism@127.0.0.1:55432/asterism_cp';
const ORIGIN = 'http://127.0.0.1:8080';
const PASSWORD = 'upload-fixture-password-01';
// Long enough to satisfy the production minimum; a fixture, not a real key.
const SIGNING_KEY = 'k'.repeat(64);

let pool: Pool;
let app: FastifyInstance;
let config: Config;
let channel: NodeChannel;
let uploadDir: string;
let passwordHash: string;

interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}

interface Fixture {
  organizationId: string;
  projectId: string;
  nodeId: string;
}

async function png(width = 32, height = 24): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 90, b: 180 } },
  })
    .png()
    .toBuffer();
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();
}

async function webp(): Promise<Buffer> {
  return sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .webp()
    .toBuffer();
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const pair = value?.split(';')[0];
  if (!pair?.startsWith(`${SESSION_COOKIE}=`)) throw new Error('session cookie missing');
  return pair;
}

async function addUser(organizationId: string, email: string, role = 'owner'): Promise<string> {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (user_id, normalized_email, display_name, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [userId, email, email.split('@')[0], passwordHash],
  );
  await pool.query(`INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, $3)`, [
    organizationId,
    userId,
    role,
  ]);
  return userId;
}

async function login(email: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: cookieFrom(response),
    csrf: response.json().csrf_token as string,
    userId: response.json().user.user_id as string,
  };
}

async function addOrganization(slug: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO organizations (organization_id, slug, display_name) VALUES ($1, $2, $3)`,
    [id, slug, slug],
  );
  return id;
}

/** A project whose Node is online and advertises image attachments. */
async function addProject(organizationId: string, suffix: string): Promise<Fixture> {
  const node = await nodesRepo.create(pool, {
    nodeId: `node-${suffix}`,
    displayName: `node ${suffix}`,
    publicKey: suffix,
    fingerprint: suffix.padEnd(64, 'a').slice(0, 64),
    organizationId,
  });
  const project = await projectsRepo.upsert(pool, {
    nodeId: node.node_id,
    nodeProjectId: `project-${suffix}`,
    displayName: `project ${suffix}`,
    enabled: true,
    metadata: { runtime_state: 'ready' },
  });
  await pool.query(
    `UPDATE nodes SET connection_state = 'online', capabilities = $2 WHERE node_id = $1`,
    [
      node.node_id,
      JSON.stringify({ attachments: { run_attachments: ['image_url'], max_per_message: 4 } }),
    ],
  );
  return { organizationId, projectId: project.project_id, nodeId: node.node_id };
}

/**
 * Build a multipart body by hand.
 *
 * Fastify's inject takes a string or buffer, so the boundary is assembled here
 * rather than through a browser API that does not exist in this process.
 */
function multipart(
  request: Record<string, unknown>,
  files: { field?: string; filename: string; type: string; body: Buffer }[],
  extraFields: Record<string, string> = {},
): { payload: Buffer; contentType: string } {
  const boundary = `----asterismtest${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  const push = (text: string) => chunks.push(Buffer.from(text, 'utf8'));

  push(`--${boundary}\r\n`);
  push('Content-Disposition: form-data; name="request"\r\n');
  push('Content-Type: application/json\r\n\r\n');
  push(`${JSON.stringify(request)}\r\n`);

  for (const [name, value] of Object.entries(extraFields)) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    push(`${value}\r\n`);
  }

  for (const file of files) {
    push(`--${boundary}\r\n`);
    push(
      `Content-Disposition: form-data; name="${file.field ?? 'images'}"; filename="${file.filename}"\r\n`,
    );
    push(`Content-Type: ${file.type}\r\n\r\n`);
    chunks.push(file.body);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);

  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function sendWithImages(
  session: Session,
  fixture: Fixture,
  files: { field?: string; filename: string; type: string; body: Buffer }[],
  request: Record<string, unknown> = {},
  extraFields: Record<string, string> = {},
) {
  const body = multipart(
    { input: 'look at this', session_id: randomUUID(), ...request },
    files,
    extraFields,
  );
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${fixture.projectId}/runs`,
    headers: {
      cookie: session.cookie,
      origin: ORIGIN,
      'x-csrf-token': session.csrf,
      'content-type': body.contentType,
    },
    payload: body.payload,
  });
}

async function storedFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  };
  await walk(uploadDir).catch(() => undefined);
  return found;
}

describe('uploading local images into chat', () => {
  beforeAll(async () => {
    pool = createPool(DATABASE_URL, 6);
    passwordHash = await hashPassword(PASSWORD);
    uploadDir = await mkdtemp(path.join(tmpdir(), 'asterism-uploads-'));
    config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL,
      PUBLIC_BASE_URL: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      ALLOW_PLAINTEXT: 'true',
      OPERATOR_COMPATIBILITY: 'false',
      LOG_LEVEL: 'fatal',
      UPLOAD_DIR: uploadDir,
      MEDIA_SIGNING_KEY: SIGNING_KEY,
    } as NodeJS.ProcessEnv);
    channel = new NodeChannel({ pool, config, log: createLogger('fatal') });
    app = await buildApp({ pool, config, log: createLogger('fatal'), channel });
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await rm(uploadDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rollbackAll(pool);
    await migrate(pool);
    await rm(uploadDir, { recursive: true, force: true });
  }, 90_000);

  async function ownerAndProject(): Promise<{ session: Session; fixture: Fixture }> {
    const fixture = await addProject(BOOTSTRAP_ORGANIZATION_ID, 'main');
    await addUser(BOOTSTRAP_ORGANIZATION_ID, 'owner@uploads.test');
    return { session: await login('owner@uploads.test'), fixture };
  }

  describe('accepted uploads', () => {
    it('accepts a PNG and records what it really is', async () => {
      const { session, fixture } = await ownerAndProject();
      const response = await sendWithImages(session, fixture, [
        { filename: 'shot.png', type: 'image/png', body: await png(64, 48) },
      ]);
      expect(response.statusCode, response.body).toBe(201);

      const rows = await pool.query('SELECT * FROM attachments');
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row.media_type).toBe('image/png');
      expect(row.width).toBe(64);
      expect(row.height).toBe(48);
      expect(row.state).toBe('ready');
      expect(row.original_filename).toBe('shot.png');
      expect(Number(row.byte_size)).toBeGreaterThan(0);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);

      // The bytes are on disk, and their size matches what was recorded.
      const files = await storedFiles();
      expect(files).toHaveLength(1);
      expect((await stat(files[0]!)).size).toBe(Number(row.byte_size));
    });

    it('accepts JPEG and WebP', async () => {
      const { session, fixture } = await ownerAndProject();
      const response = await sendWithImages(session, fixture, [
        { filename: 'a.jpg', type: 'image/jpeg', body: await jpeg() },
        { filename: 'b.webp', type: 'image/webp', body: await webp() },
      ]);
      expect(response.statusCode, response.body).toBe(201);
      const rows = await pool.query('SELECT media_type FROM attachments ORDER BY media_type');
      expect(rows.rows.map((r) => r.media_type)).toEqual(['image/jpeg', 'image/webp']);
    });

    it('mixes uploaded images with a public URL up to the shared limit of four', async () => {
      const { session, fixture } = await ownerAndProject();
      const response = await sendWithImages(
        session,
        fixture,
        [
          { filename: '1.png', type: 'image/png', body: await png() },
          { filename: '2.png', type: 'image/png', body: await png() },
          { filename: '3.png', type: 'image/png', body: await png() },
        ],
        { attachments: [{ type: 'image_url', url: 'https://example.test/photo.png' }] },
      );
      expect(response.statusCode, response.body).toBe(201);

      const command = await pool.query(
        `SELECT request_payload FROM remote_commands WHERE command_type = 'runs.create'`,
      );
      const sent = command.rows[0].request_payload.attachments as { url: string }[];
      // Four in total, the linked one first, then the uploads in order.
      expect(sent).toHaveLength(4);
      expect(sent[0]!.url).toBe('https://example.test/photo.png');
      for (const attachment of sent.slice(1)) {
        expect(attachment.url).toContain(MEDIA_ROUTE_PREFIX);
      }
    });

    it('refuses a fifth image', async () => {
      const { session, fixture } = await ownerAndProject();
      const response = await sendWithImages(
        session,
        fixture,
        [
          { filename: '1.png', type: 'image/png', body: await png() },
          { filename: '2.png', type: 'image/png', body: await png() },
          { filename: '3.png', type: 'image/png', body: await png() },
          { filename: '4.png', type: 'image/png', body: await png() },
        ],
        { attachments: [{ type: 'image_url', url: 'https://example.test/photo.png' }] },
      );
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe('too_many_attachments');
      expect(await storedFiles(), 'nothing may be stored for a refused message').toHaveLength(0);
    });

    it('keeps a per-image label with its image', async () => {
      const { session, fixture } = await ownerAndProject();
      const response = await sendWithImages(
        session,
        fixture,
        [
          { filename: 'one.png', type: 'image/png', body: await png() },
          { filename: 'two.png', type: 'image/png', body: await png() },
        ],
        {},
        { 'alt.1': 'the second one' },
      );
      expect(response.statusCode, response.body).toBe(201);
      const links = await pool.query('SELECT position, alt FROM run_attachments ORDER BY position');
      expect(links.rows).toEqual([
        { position: 0, alt: null },
        { position: 1, alt: 'the second one' },
      ]);
    });
  });

  describe('refused uploads', () => {
    it.each([
      [
        'an SVG',
        'drawing.svg',
        'image/png',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      ],
      ['a zero-byte file', 'empty.png', 'image/png', Buffer.alloc(0)],
      ['rubbish', 'fake.png', 'image/png', Buffer.from('not an image')],
    ])('refuses %s without storing anything', async (_label, filename, type, body) => {
      const { session, fixture } = await ownerAndProject();
      const response = await sendWithImages(session, fixture, [{ filename, type, body }]);
      expect(response.statusCode).toBe(422);
      expect(await storedFiles()).toHaveLength(0);
      expect((await pool.query('SELECT * FROM attachments')).rows).toHaveLength(0);
      expect((await pool.query('SELECT * FROM runs')).rows).toHaveLength(0);
    });

    it('refuses a real image sent under the wrong media type', async () => {
      const { session, fixture } = await ownerAndProject();
      const response = await sendWithImages(session, fixture, [
        { filename: 'lying.jpg', type: 'image/jpeg', body: await png() },
      ]);
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe('media_type_mismatch');
      expect(await storedFiles()).toHaveLength(0);
    });

    it('refuses an image with too many pixels on a side', async () => {
      const { session, fixture } = await ownerAndProject();
      const response = await sendWithImages(session, fixture, [
        { filename: 'wide.png', type: 'image/png', body: await png(9000, 4) },
      ]);
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe('image_too_large');
      expect(await storedFiles()).toHaveLength(0);
    });

    it('refuses uploads when the Node is offline, before storing a file', async () => {
      const { session, fixture } = await ownerAndProject();
      await pool.query(`UPDATE nodes SET connection_state = 'offline' WHERE node_id = $1`, [
        fixture.nodeId,
      ]);
      const response = await sendWithImages(session, fixture, [
        { filename: 'shot.png', type: 'image/png', body: await png() },
      ]);
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe('attachments_unsupported');
      expect(await storedFiles(), 'an offline Node must not cost a stored file').toHaveLength(0);
    });

    it('refuses uploads when the Node does not advertise image attachments', async () => {
      const { session, fixture } = await ownerAndProject();
      await pool.query(`UPDATE nodes SET capabilities = $2 WHERE node_id = $1`, [
        fixture.nodeId,
        JSON.stringify({ attachments: { run_attachments: [] } }),
      ]);
      const response = await sendWithImages(session, fixture, [
        { filename: 'shot.png', type: 'image/png', body: await png() },
      ]);
      expect(response.statusCode).toBe(422);
      expect(await storedFiles()).toHaveLength(0);
    });

    it('refuses a file part it was not expecting', async () => {
      const { session, fixture } = await ownerAndProject();
      const response = await sendWithImages(session, fixture, [
        { field: 'documents', filename: 'x.png', type: 'image/png', body: await png() },
      ]);
      expect(response.statusCode).toBe(422);
      expect(await storedFiles()).toHaveLength(0);
    });
  });

  describe('the browser view', () => {
    it('shows the attachment after a reload, without the provider capability', async () => {
      const { session, fixture } = await ownerAndProject();
      await sendWithImages(session, fixture, [
        { filename: 'shot.png', type: 'image/png', body: await png() },
      ]);

      const chat = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${fixture.projectId}/chat`,
        headers: { cookie: session.cookie },
      });
      expect(chat.statusCode).toBe(200);
      const runs = chat.json().runs as { uploaded_attachments?: Record<string, unknown>[] }[];
      expect(runs).toHaveLength(1);
      const uploaded = runs[0]!.uploaded_attachments!;
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0]!.type).toBe('uploaded_image');
      expect(uploaded[0]!.content_url).toContain('/attachments/');

      // The capability must not be anywhere in this response, nor may the
      // storage key or any host path.
      expect(chat.body).not.toContain(MEDIA_ROUTE_PREFIX);
      expect(chat.body).not.toContain(uploadDir);
      expect(chat.body).not.toContain('storage_key');
      expect(chat.body).not.toContain(SIGNING_KEY);
    });

    it('serves the image to an authorized session and refuses an anonymous one', async () => {
      const { session, fixture } = await ownerAndProject();
      await sendWithImages(session, fixture, [
        { filename: 'shot.png', type: 'image/png', body: await png() },
      ]);
      const attachmentId = (await pool.query('SELECT attachment_id FROM attachments')).rows[0]
        .attachment_id as string;
      const url = `/api/v1/projects/${fixture.projectId}/attachments/${attachmentId}/content`;

      const authorized = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: session.cookie },
      });
      expect(authorized.statusCode).toBe(200);
      expect(authorized.headers['content-type']).toBe('image/png');
      expect(authorized.headers['x-content-type-options']).toBe('nosniff');
      expect(authorized.headers['cache-control']).toBe('private, no-store');

      const anonymous = await app.inject({ method: 'GET', url });
      expect(anonymous.statusCode).toBe(401);
    });

    it('refuses an attachment belonging to another organization or project', async () => {
      const { session, fixture } = await ownerAndProject();
      await sendWithImages(session, fixture, [
        { filename: 'shot.png', type: 'image/png', body: await png() },
      ]);
      const attachmentId = (await pool.query('SELECT attachment_id FROM attachments')).rows[0]
        .attachment_id as string;

      // Same organization, different project.
      const other = await addProject(BOOTSTRAP_ORGANIZATION_ID, 'other');
      const wrongProject = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${other.projectId}/attachments/${attachmentId}/content`,
        headers: { cookie: session.cookie },
      });
      expect(wrongProject.statusCode).toBe(404);

      // A different organization entirely, with its own member.
      const otherOrg = await addOrganization('outsiders');
      const outsideFixture = await addProject(otherOrg, 'outside');
      await addUser(otherOrg, 'outsider@uploads.test');
      const outsider = await login('outsider@uploads.test');
      const crossOrg = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${outsideFixture.projectId}/attachments/${attachmentId}/content`,
        headers: { cookie: outsider.cookie },
      });
      expect(crossOrg.statusCode).toBe(404);
    });
  });

  describe('the provider capability', () => {
    async function storedAttachment(): Promise<string> {
      const rows = await pool.query('SELECT attachment_id FROM attachments');
      return rows.rows[0].attachment_id as string;
    }

    it('serves the image without any cookie, and refuses a tampered link', async () => {
      const { session, fixture } = await ownerAndProject();
      await sendWithImages(session, fixture, [
        { filename: 'shot.png', type: 'image/png', body: await png() },
      ]);
      const attachmentId = await storedAttachment();
      const signature = signAttachment(attachmentId, SIGNING_KEY);

      const fetched = await app.inject({
        method: 'GET',
        url: `${MEDIA_ROUTE_PREFIX}/${attachmentId}/${signature}`,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.headers['content-type']).toBe('image/png');
      expect(fetched.headers['x-content-type-options']).toBe('nosniff');
      expect(Number(fetched.headers['content-length'])).toBeGreaterThan(0);

      const head = await app.inject({
        method: 'HEAD',
        url: `${MEDIA_ROUTE_PREFIX}/${attachmentId}/${signature}`,
      });
      expect(head.statusCode).toBe(200);

      // One character of the signature.
      const flipped = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
      const tampered = await app.inject({
        method: 'GET',
        url: `${MEDIA_ROUTE_PREFIX}/${attachmentId}/${flipped}`,
      });
      expect(tampered.statusCode).toBe(404);

      // A different attachment id under a signature that is valid for another.
      const wrongId = await app.inject({
        method: 'GET',
        url: `${MEDIA_ROUTE_PREFIX}/att_${'0'.repeat(32)}/${signature}`,
      });
      expect(wrongId.statusCode).toBe(404);
    });

    it('stops serving a disabled attachment', async () => {
      const { session, fixture } = await ownerAndProject();
      await sendWithImages(session, fixture, [
        { filename: 'shot.png', type: 'image/png', body: await png() },
      ]);
      const attachmentId = await storedAttachment();
      const signature = signAttachment(attachmentId, SIGNING_KEY);
      await pool.query(`UPDATE attachments SET state = 'disabled' WHERE attachment_id = $1`, [
        attachmentId,
      ]);

      const revoked = await app.inject({
        method: 'GET',
        url: `${MEDIA_ROUTE_PREFIX}/${attachmentId}/${signature}`,
      });
      expect(revoked.statusCode).toBe(404);

      const unknown = await app.inject({
        method: 'GET',
        url: `${MEDIA_ROUTE_PREFIX}/att_${'f'.repeat(32)}/${signature}`,
      });
      // An unknown attachment and a revoked one are indistinguishable.
      expect(unknown.statusCode).toBe(404);
      expect(unknown.body).toBe(revoked.body);
    });

    it('does not put the capability in the database', async () => {
      const { session, fixture } = await ownerAndProject();
      await sendWithImages(session, fixture, [
        { filename: 'shot.png', type: 'image/png', body: await png() },
      ]);
      const attachments = await pool.query('SELECT * FROM attachments');
      expect(JSON.stringify(attachments.rows)).not.toContain(MEDIA_ROUTE_PREFIX);

      const runs = await pool.query('SELECT request_metadata FROM runs');
      expect(JSON.stringify(runs.rows)).not.toContain(MEDIA_ROUTE_PREFIX);

      const audit = await pool.query('SELECT * FROM audit_log');
      expect(JSON.stringify(audit.rows)).not.toContain(MEDIA_ROUTE_PREFIX);

      // It exists in exactly one place: the command the Node executes.
      const command = await pool.query('SELECT request_payload FROM remote_commands');
      expect(JSON.stringify(command.rows)).toContain(MEDIA_ROUTE_PREFIX);
    });
  });

  describe('normalization and durability', () => {
    it('stores an image stripped of EXIF and GPS', async () => {
      const { session, fixture } = await ownerAndProject();
      const withExif = await sharp({
        create: { width: 24, height: 24, channels: 3, background: { r: 8, g: 8, b: 8 } },
      })
        .withExif({ IFD0: { ImageDescription: 'SECRET-PLACE' }, GPS: { GPSLatitudeRef: 'N' } })
        .jpeg()
        .toBuffer();

      await sendWithImages(session, fixture, [
        { filename: 'photo.jpg', type: 'image/jpeg', body: withExif },
      ]);
      const files = await storedFiles();
      expect(files).toHaveLength(1);
      const stored = await readFile(files[0]!);
      expect(stored.toString('latin1')).not.toContain('SECRET-PLACE');
      expect((await sharp(stored).metadata()).exif).toBeUndefined();
    });

    it('records a digest of the stored bytes, not of the upload', async () => {
      const { session, fixture } = await ownerAndProject();
      const original = await png(30, 30);
      await sendWithImages(session, fixture, [
        { filename: 'x.png', type: 'image/png', body: original },
      ]);
      const row = (await pool.query('SELECT sha256 FROM attachments')).rows[0];
      const files = await storedFiles();
      const { createHash } = await import('node:crypto');
      const storedDigest = createHash('sha256')
        .update(await readFile(files[0]!))
        .digest('hex');
      expect(row.sha256).toBe(storedDigest);
    });

    it('reuses the same stored bytes on retry', async () => {
      const { session, fixture } = await ownerAndProject();
      const created = await sendWithImages(session, fixture, [
        { filename: 'x.png', type: 'image/png', body: await png() },
      ]);
      const runId = created.json().run.run_id as string;
      // Retry is only offered for an interrupted run.
      await pool.query(
        `UPDATE runs SET status = 'interrupted', node_run_id = 'arun_test' WHERE run_id = $1`,
        [runId],
      );

      const retried = await app.inject({
        method: 'POST',
        url: `/api/v1/runs/${runId}/retry`,
        headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf },
      });
      expect(retried.statusCode, retried.body).toBe(202);

      // One attachment row and one file, referenced by two runs.
      expect((await pool.query('SELECT * FROM attachments')).rows).toHaveLength(1);
      expect(await storedFiles()).toHaveLength(1);
      const links = await pool.query('SELECT run_id, attachment_id FROM run_attachments');
      expect(links.rows).toHaveLength(2);
      expect(new Set(links.rows.map((r) => r.attachment_id)).size).toBe(1);
    });

    it('leaves nothing behind when the run cannot be created', async () => {
      const { session, fixture } = await ownerAndProject();
      // An input the run schema refuses, submitted with a perfectly good image.
      const response = await sendWithImages(
        session,
        fixture,
        [{ filename: 'x.png', type: 'image/png', body: await png() }],
        { input: '' },
      );
      expect(response.statusCode).toBe(400);
      expect(await storedFiles()).toHaveLength(0);
      expect((await pool.query('SELECT * FROM attachments')).rows).toHaveLength(0);
    });
  });

  describe('existing behaviour', () => {
    it('leaves a text-only JSON run untouched', async () => {
      const { session, fixture } = await ownerAndProject();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${fixture.projectId}/runs`,
        headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf },
        payload: { input: 'plain text', session_id: randomUUID() },
      });
      expect(response.statusCode, response.body).toBe(201);
      const command = await pool.query('SELECT request_payload FROM remote_commands');
      expect(command.rows[0].request_payload.attachments).toBeUndefined();
      expect(await storedFiles()).toHaveLength(0);
    });

    it('leaves a public image URL run untouched', async () => {
      const { session, fixture } = await ownerAndProject();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${fixture.projectId}/runs`,
        headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf },
        payload: {
          input: 'look',
          session_id: randomUUID(),
          attachments: [{ type: 'image_url', url: 'https://example.test/a.png' }],
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      const command = await pool.query('SELECT request_payload FROM remote_commands');
      expect(command.rows[0].request_payload.attachments).toEqual([
        { type: 'image_url', url: 'https://example.test/a.png' },
      ]);
      expect((await pool.query('SELECT * FROM attachments')).rows).toHaveLength(0);
    });
  });
});
