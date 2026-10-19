// The admin Worker's own check of the Cloudflare Access token, with a locally made key pair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccess, accessKeys } from '../server/admin/access.js';

const TEAM = 'sevens', AUD = 'aud-123', NOW = Date.UTC(2026, 9, 19, 12);
const algo = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const mine = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']);
const keys = [{ ...(await crypto.subtle.exportKey('jwk', mine.publicKey)), kid: 'k1' }];

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
async function token(over = {}, { kid = 'k1', key = mine.privateKey, alg = 'RS256' } = {}) {
  const t = Math.floor(NOW / 1000);
  const payload = { aud: [AUD], iss: `https://${TEAM}.cloudflareaccess.com`, email: 'owner@example.com', iat: t, nbf: t, exp: t + 3600, ...over };
  const head = b64({ alg, kid, typ: 'JWT' }), body = b64(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}
const check = tok => verifyAccess(tok, { team: TEAM, aud: AUD, keys, now: NOW });

test('a valid Access token passes and names the signed-in email', async () => {
  assert.deepEqual(await check(await token()), { ok: true, email: 'owner@example.com' });
  assert.ok((await check(await token({ aud: AUD }))).ok, 'aud may be a plain string');
});

test('anything else is refused', async () => {
  assert.equal((await check(undefined)).error, 'missing');
  assert.equal((await check('a.b')).error, 'malformed');
  assert.equal((await check('x.y.z')).error, 'malformed');
  assert.equal((await check(await token({}, { alg: 'HS256' }))).error, 'algorithm');
  assert.equal((await check(await token({}, { kid: 'k9' }))).error, 'unknown_key');
  assert.equal((await check(await token({}, { key: other.privateKey }))).error, 'signature');
  const good = await token(), [h, p, s] = good.split('.');
  const forged = `${h}.${b64({ ...JSON.parse(Buffer.from(p, 'base64url')), email: 'evil@example.com' })}.${s}`;
  assert.equal((await check(forged)).error, 'signature');
  assert.equal((await check(await token({ aud: ['someone-else'] }))).error, 'audience');
  assert.equal((await check(await token({ iss: 'https://evil.cloudflareaccess.com' }))).error, 'issuer');
  assert.equal((await check(await token({ exp: Math.floor(NOW / 1000) - 1 }))).error, 'expired');
  assert.equal((await check(await token({ nbf: Math.floor(NOW / 1000) + 3600 }))).error, 'not_yet_valid');
});

test('odd claims and settings never get through', async () => {
  const t = Math.floor(NOW / 1000);
  assert.equal((await check(await token({ exp: undefined }))).error, 'expired');
  assert.equal((await check(await token({ exp: String(t + 3600) }))).error, 'expired', 'exp must be a number');
  assert.equal((await check(await token({ nbf: String(t + 3600) }))).error, 'not_yet_valid', 'nbf must be a number');
  assert.equal((await check(await token({ aud: undefined }))).error, 'audience');
  // a key without a kid must not match a token without a kid
  const noKid = await token({}, { kid: undefined });
  assert.equal((await verifyAccess(noKid, { team: TEAM, aud: AUD, keys: [{ ...keys[0], kid: undefined }], now: NOW })).error, 'unknown_key');
  // unset team or audience settings refuse everything
  const good = await token();
  assert.ok((await verifyAccess(good, { team: '', aud: AUD, keys, now: NOW })).error);
  assert.equal((await verifyAccess(good, { team: TEAM, aud: '', keys, now: NOW })).error, 'audience');
  assert.equal((await verifyAccess(good, { team: TEAM, aud: AUD, keys: undefined, now: NOW })).error, 'unknown_key');
});

test('the team keys are fetched once an hour', async () => {
  let calls = 0;
  const fetcher = async url => { calls++; assert.equal(url, 'https://cachetest.cloudflareaccess.com/cdn-cgi/access/certs'); return new Response(JSON.stringify({ keys })); };
  await accessKeys('cachetest', { fetcher, now: 0 });
  await accessKeys('cachetest', { fetcher, now: 59 * 60_000 });
  assert.equal(calls, 1);
  await accessKeys('cachetest', { fetcher, now: 61 * 60_000 });
  assert.equal(calls, 2);
  await assert.rejects(accessKeys('broken', { fetcher: async () => new Response('no', { status: 500 }), now: 0 }));
});
