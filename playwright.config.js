// Browser tests: `npm run test:e2e` (against the Node server) or `npm run test:worker` (online tests against `wrangler dev`).
import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 8790;
const WORKER = process.env.TARGET === 'worker';
// the Node server's data directory, made once: the test workers inherit it, so tests can write rows into its database (helpers.js setFlags)
process.env.SEVENS_E2E_DATA ||= mkdtempSync(path.join(tmpdir(), 'sevens-e2e-'));

export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: 'admin.spec.js',
  timeout: 90_000,
  expect: { timeout: 8_000 },
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'node server/node/server.js',
      url: `http://127.0.0.1:${PORT}/health`,
      // every test phone comes from 127.0.0.1, so the per-IP limit on /auth is lifted (the page fetches passkey options ahead)
      env: { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: process.env.SEVENS_E2E_DATA, AUTH_LIMIT: '100000' },
      reuseExistingServer: false
    },
    ...(WORKER ? [{
      command: 'npx wrangler dev -c server/cloudflare/wrangler.jsonc --port 8787 --ip 127.0.0.1 --persist-to .wrangler/e2e --var ALLOWED_ORIGINS:* --var AUTH_NO_LIMIT:1',
      url: 'http://127.0.0.1:8787/health',
      timeout: 120_000,
      reuseExistingServer: false
    }] : [])
  ]
});
