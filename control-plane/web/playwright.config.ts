import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  use: {
    baseURL: process.env.WEB_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.WEB_BASE_URL
    ? undefined
    : {
        command: 'npm run dev -- --host 127.0.0.1 --port 4173',
        port: 4173,
        reuseExistingServer: true,
      },
});
