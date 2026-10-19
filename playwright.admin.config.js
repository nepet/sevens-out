// Browser tests for the admin page: `npm run test:admin` (tests/e2e/d1-setup.mjs resets the local D1 first).
import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'admin.spec.js',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node server/node/server.js',
      url: 'http://127.0.0.1:8790/health',
      env: { PORT: '8790', HOST: '127.0.0.1', DATA_DIR: mkdtempSync(path.join(tmpdir(), 'sevens-admin-e2e-')) },
      reuseExistingServer: false
    },
    {
      command: 'npx wrangler dev -c server/cloudflare/wrangler.jsonc --port 8787 --ip 127.0.0.1 --inspector-port 9231 --persist-to .wrangler/e2e --var ALLOWED_ORIGINS:*',
      url: 'http://127.0.0.1:8787/health',
      timeout: 120_000,
      reuseExistingServer: false
    },
    {
      command: 'npx wrangler dev -c server/admin/wrangler.jsonc --port 8789 --ip 127.0.0.1 --inspector-port 9232 --persist-to .wrangler/e2e --var ADMIN_DEV_NO_ACCESS:1',
      url: 'http://127.0.0.1:8789/api/stats',
      timeout: 120_000,
      reuseExistingServer: false
    }
  ]
});
