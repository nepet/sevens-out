// The admin Worker: sign-in check, routes and API, with a D1 stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// let `import PAGE from './page.html'` load the file as text, as wrangler does
register('data:text/javascript,' + encodeURIComponent(`
  export async function load(url, ctx, next) {
    if (url.endsWith('.html')) {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url), 'utf8')) };
    }
    return next(url, ctx);
  }`));

const { fakeD1 } = await import('./fake-d1.js');
const { fromD1 } = await import('../server/d1/db.js');
const { writeRecord } = await import('../server/d1/write.js');
const { summarize } = await import('../server/core/stats.js');
const { quickGame } = await import('./games.js');
const { handle } = await import('../server/admin/worker.js');

const ID = 'abcdefabcdefabcd';
const local = (path, init) => new Request(`http://127.0.0.1:8789${path}`, init);
async function devEnv() {
  const d1 = fakeD1();
  await writeRecord(fromD1(d1), summarize(quickGame(['Anna', 'Ben']), { id: ID, source: 'phone', startedAt: Date.now() - 60_000, finishedAt: Date.now(), status: 'over' }));
  return { STATS: d1, ADMIN_DEV_NO_ACCESS: '1' };
}

test('locally (dev mode on 127.0.0.1) the page and the API answer', async () => {
  const env = await devEnv();
  const page = await handle(local('/'), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const s = await (await handle(local('/api/stats?period=all'), env)).json();
  assert.equal(s.activity.games, 1);
  const list = await (await handle(local('/api/games'), env)).json();
  assert.deepEqual(list.games.map(g => g.id), [ID]);
  const one = await handle(local(`/api/games/${ID}`), env);
  assert.equal((await one.json()).sheet.players[0], 'Anna');
  assert.equal((await handle(local('/api/games/ffffffffffffffff'), env)).status, 404);
  assert.equal((await handle(local('/api/games/nope'), env)).status, 404);
  assert.equal((await handle(local('/api/nothing'), env)).status, 404);
  assert.equal((await handle(local(`/api/games/${ID}`, { method: 'DELETE' }), env)).status, 204);
  assert.equal((await handle(local(`/api/games/${ID}`), env)).status, 404);
  env.STATS.down = true;
  const broken = await handle(local('/api/stats'), env);
  assert.equal(broken.status, 500);
  assert.deepEqual(await broken.json(), { error: 'server' });
});

// a real-looking Access setup with a locally made key
const TEAM = 'sevens', AUD = 'aud-123', OWNER = 'Owner@Example.com';
const algo = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const pair = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']);
const keys = [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' }];
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
async function token(email) {
  const t = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'k1' }), body = b64({ aud: [AUD], iss: `https://${TEAM}.cloudflareaccess.com`, email, exp: t + 600 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const live = (headers = {}) => new Request('https://sevens-out-admin.example.workers.dev/', { headers });

test('on the internet only the owner gets in', async () => {
  const env = { ...(await devEnv()), ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ADMIN_EMAIL: 'owner@example.com' };
  const deps = { keys: async () => keys };
  assert.equal((await handle(live(), env, deps)).status, 403, 'dev mode does not count off 127.0.0.1');
  assert.equal((await handle(live({ 'Cf-Access-Jwt-Assertion': await token('someone@example.com') }), env, deps)).status, 403);
  assert.equal((await handle(live({ 'Cf-Access-Jwt-Assertion': await token(OWNER) }), env, deps)).status, 200);
  const unconfigured = await handle(live({ 'Cf-Access-Jwt-Assertion': await token(OWNER) }), { STATS: env.STATS }, deps);
  assert.equal(unconfigured.status, 500);
  const noKeys = await handle(live({ 'Cf-Access-Jwt-Assertion': await token(OWNER) }), env, { keys: async () => { throw new Error('down'); } });
  assert.equal(noKeys.status, 503);
});
