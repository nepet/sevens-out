// Resets the local D1 that the wrangler dev servers in the browser tests share, and loads the schema.
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const STATE = '.wrangler/e2e';
rmSync(STATE, { recursive: true, force: true });
execFileSync('npx', ['wrangler', 'd1', 'execute', 'sevens-out-stats', '--local', '--persist-to', STATE,
  '-c', 'server/cloudflare/wrangler.jsonc', '--file', 'server/d1/schema.sql'], { stdio: 'inherit' });
