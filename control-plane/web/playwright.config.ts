import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  use: {
    baseURL: process.env.WEB_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  // Two suites with different needs, kept apart so neither drags the other's
  // requirements along. `chromium` is the mocked console: no Control Plane, no
  // database, no Node. `live` boots the real server and a real signed Node, so
  // it needs the backend's dependencies and PostgreSQL, and runs where those
  // already exist.
  projects: [
    {
      name: 'chromium',
      testIgnore: /new-project\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'live',
      testMatch: /new-project\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.WEB_BASE_URL
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 4173',
        port: 4173,
        reuseExistingServer: true,
      },
});
