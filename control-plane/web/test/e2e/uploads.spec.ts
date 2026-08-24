/**
 * Mocked browser coverage for uploading a local image from the composer.
 *
 * The backend is stubbed; what is exercised here is the part only a real
 * browser has: a file input, object URLs, a multipart body, and the previews
 * that come and go with them.
 */
import { expect, test, type Page, type Request, type Route } from '@playwright/test';

const ORGANIZATION = { organization_id: 'org_bootstrap', slug: 'bootstrap', role: 'owner' };
const PROJECT_ID = 'project-1';
const ALL_PERMISSIONS = ['project.read', 'run.read', 'run.create', 'run.manage_own'];

const UPLOAD_LIMITS = {
  available: true,
  configured: true,
  max_attachments: 4,
  max_bytes: 10 * 1024 * 1024,
  max_request_bytes: 32 * 1024 * 1024,
  max_dimension: 8192,
  max_pixels: 25_000_000,
  media_types: ['image/png', 'image/jpeg', 'image/webp'],
};

/** A one-pixel PNG, small enough to inline and real enough for the picker. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

interface MockOptions {
  uploads?: typeof UPLOAD_LIMITS | { available: false; configured: false };
  runs?: Record<string, unknown>[];
}

async function mockChat(page: Page, options: MockOptions = {}) {
  const submissions: { contentType: string; body: string }[] = [];
  const runs = [...(options.runs ?? [])];

  await page.route('**/api/v1/**', async (route: Route) => {
    const request: Request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/v1/auth/session') {
      return json(route, {
        user: { user_id: 'owner', email: 'owner@example.com', display_name: 'owner' },
        active_organization: ORGANIZATION,
        permissions: ALL_PERMISSIONS,
      });
    }
    if (path === '/api/v1/organizations') return json(route, { organizations: [ORGANIZATION] });
    if (path === '/api/v1/overview') return json(route, { counts: {}, recent_problem_runs: [] });
    if (path === '/api/v1/projects') {
      return json(route, {
        projects: [
          {
            project_id: PROJECT_ID,
            display_name: 'Demo',
            node_id: 'node-1',
            enabled: true,
            available: true,
          },
        ],
      });
    }

    if (path === `/api/v1/projects/${PROJECT_ID}/chat`) {
      return json(route, {
        session_id: 'session-1',
        runs,
        node_capabilities: {
          connection_status: 'online',
          capabilities_known: true,
          run_approval_policy: ['manual'],
          supports_run_approval_policy: true,
          run_approval_policy_available: true,
          run_attachments: ['image_url'],
          image_attachments_available: true,
        },
        uploads: options.uploads ?? UPLOAD_LIMITS,
      });
    }

    if (path === `/api/v1/projects/${PROJECT_ID}/runs` && request.method() === 'POST') {
      submissions.push({
        contentType: request.headers()['content-type'] ?? '',
        body: request.postData() ?? '',
      });
      const created = {
        run_id: `run-${runs.length + 1}`,
        project_id: PROJECT_ID,
        node_id: 'node-1',
        status: 'completed',
        session_id: 'session-1',
        request_metadata: { input_length: 4, session_id: 'session-1' },
        created_at: new Date().toISOString(),
        last_event_seq: '0',
        uploaded_attachments: [
          {
            type: 'uploaded_image',
            attachment_id: 'att_1',
            media_type: 'image/png',
            byte_size: PIXEL_PNG.byteLength,
            width: 1,
            height: 1,
            original_filename: 'marker.png',
            state: 'ready',
            content_url: `/api/v1/projects/${PROJECT_ID}/attachments/att_1/content`,
          },
        ],
      };
      runs.push(created);
      return json(route, { run: created }, 201);
    }

    if (path.endsWith('/content')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL_PNG });
    }
    if (path.endsWith('/events/stream')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }
    if (path.endsWith('/events')) return json(route, { events: [] });

    // The project detail the chat page loads alongside the conversation.
    if (path.startsWith(`/api/v1/projects/${PROJECT_ID}`)) {
      return json(route, {
        project: {
          project_id: PROJECT_ID,
          node_id: 'node-1',
          node_project_id: 'workspace',
          display_name: 'Demo',
          enabled: true,
          available: true,
          first_seen_at: '2026-01-01T00:00:00.000Z',
          last_seen_at: '2026-01-01T00:00:00.000Z',
          metadata: {},
        },
        node: { node_id: 'node-1', display_name: 'Demo Node' },
        active_run: null,
        recent_runs: [],
      });
    }

    return json(route, {});
  });

  return { submissions };
}

async function openChat(page: Page): Promise<void> {
  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
}

test.describe('uploading a local image', () => {
  test('previews a chosen file and sends it as multipart', async ({ page }) => {
    const mock = await mockChat(page);
    await openChat(page);

    await page.getByRole('button', { name: 'Add image' }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'marker.png',
      mimeType: 'image/png',
      buffer: PIXEL_PNG,
    });

    // The preview comes from browser memory: nothing has been uploaded yet.
    const preview = page.locator('.chat-attachment-previews img').first();
    await expect(preview).toBeVisible();
    expect(await preview.getAttribute('src')).toMatch(/^blob:/);
    expect(mock.submissions, 'choosing a file must not upload it').toHaveLength(0);

    await page.getByLabel('Label for marker.png').fill('the marker');
    await page.getByLabel('Message').fill('read it');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => mock.submissions.length).toBe(1);
    const submission = mock.submissions[0]!;
    expect(submission.contentType).toContain('multipart/form-data');
    expect(submission.body).toContain('name="request"');
    expect(submission.body).toContain('name="images"; filename="marker.png"');
    expect(submission.body).toContain('the marker');

    // Once sent, the composer is empty and the turn shows the stored image
    // through the authenticated content endpoint.
    await expect(page.locator('.chat-attachment-previews:not(.submitted) img')).toHaveCount(0);
    const submitted = page.locator('.chat-attachment-previews.submitted img').first();
    await expect(submitted).toBeVisible();
    expect(await submitted.getAttribute('src')).toContain('/attachments/att_1/content');
  });

  test('removes a chosen file before sending', async ({ page }) => {
    const mock = await mockChat(page);
    await openChat(page);

    await page.getByRole('button', { name: 'Add image' }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'marker.png',
      mimeType: 'image/png',
      buffer: PIXEL_PNG,
    });
    await expect(page.locator('.chat-attachment-previews img')).toHaveCount(1);

    await page.getByRole('button', { name: 'Remove marker.png' }).click();
    await expect(page.locator('.chat-attachment-previews img')).toHaveCount(0);

    await page.getByLabel('Message').fill('never mind');
    await page.getByRole('button', { name: 'Send' }).click();

    // With no files left the request goes back to being plain JSON.
    await expect.poll(() => mock.submissions.length).toBe(1);
    expect(mock.submissions[0]!.contentType).toContain('application/json');
  });

  test('refuses a fifth image and says why', async ({ page }) => {
    await mockChat(page);
    await openChat(page);

    const files = Array.from({ length: 5 }, (_, index) => ({
      name: `image-${index}.png`,
      mimeType: 'image/png',
      buffer: PIXEL_PNG,
    }));
    await page.getByRole('button', { name: 'Add image' }).click();
    await page.locator('input[type="file"]').setInputFiles(files);

    await expect(page.locator('.chat-attachment-previews img')).toHaveCount(4);
    await expect(page.getByRole('alert')).toContainText('At most 4 images');
  });

  test('refuses an unsupported type without touching the server', async ({ page }) => {
    const mock = await mockChat(page);
    await openChat(page);

    await page.getByRole('button', { name: 'Add image' }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'animation.gif',
      mimeType: 'image/gif',
      buffer: Buffer.from('GIF89a'),
    });

    await expect(page.getByRole('alert')).toContainText('not a supported image type');
    await expect(page.locator('.chat-attachment-previews img')).toHaveCount(0);
    expect(mock.submissions).toHaveLength(0);
  });

  test('hides the control when the deployment cannot store images', async ({ page }) => {
    await mockChat(page, { uploads: { available: false, configured: false } });
    await openChat(page);

    await expect(page.getByRole('button', { name: 'Add image' })).toHaveCount(0);
    // The URL attachment path is unaffected by storage being absent.
    await expect(page.getByRole('button', { name: 'Attach image URL' })).toBeVisible();
  });

  test('restores one card after a reload, without duplicating it', async ({ page }) => {
    await mockChat(page, {
      runs: [
        {
          run_id: 'run-1',
          project_id: PROJECT_ID,
          node_id: 'node-1',
          status: 'completed',
          session_id: 'session-1',
          request_metadata: { input_length: 4, session_id: 'session-1' },
          created_at: new Date().toISOString(),
          last_event_seq: '0',
          uploaded_attachments: [
            {
              type: 'uploaded_image',
              attachment_id: 'att_1',
              media_type: 'image/png',
              byte_size: PIXEL_PNG.byteLength,
              width: 1,
              height: 1,
              original_filename: 'marker.png',
              state: 'ready',
              content_url: `/api/v1/projects/${PROJECT_ID}/attachments/att_1/content`,
            },
          ],
        },
      ],
    });
    await openChat(page);
    await expect(page.locator('.chat-attachment-previews.submitted img')).toHaveCount(1);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
    await expect(page.locator('.chat-attachment-previews.submitted img')).toHaveCount(1);
  });
});
