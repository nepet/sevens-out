// Passkey checks: registration and sign-in with real keys, and every way they are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64url, WebAuthnError, parseAuthData, derToRaw, verifyRegistration, verifyAssertion, ES256, RS256 } from '../server/core/webauthn.js';
import { softAuthenticator, rawToDer } from './authenticator.js';

const ORIGIN = 'http://localhost:8788', ORIGINS = [ORIGIN, 'https://nepet.github.io'];
const CH = b64url.encode(crypto.getRandomValues(new Uint8Array(32)));
const code = c => err => err instanceof WebAuthnError && err.code === c;

async function registered(opts) {
  const a = await softAuthenticator(opts);
  const userId = b64url.encode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  const reg = await verifyRegistration({ credential: await a.create({ challenge: CH, userId }), challenge: CH, origins: ORIGINS });
  const signIn = (cred, extra = {}) => verifyAssertion({ credential: cred, challenge: CH, origins: ORIGINS, publicKey: reg.publicKey, alg: reg.alg, signCount: reg.signCount, ...extra });
  return { a, reg, userId, signIn };
}

test('base64url round-trips and refuses padding and other alphabets', () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  for (let n = 0; n <= 10; n++) assert.deepEqual(b64url.decode(b64url.encode(bytes.subarray(0, n))), bytes.subarray(0, n));
  assert.equal(b64url.encode(new Uint8Array([0xfb, 0xff]).buffer), '-_8');
  for (const bad of ['ab=', 'a+b', 'a/b', 'a b', 'abcde', null, 5]) assert.throws(() => b64url.decode(bad), code('encoding'), String(bad));
});

for (const alg of [ES256, RS256]) {
  test(`registers and signs in with ${alg === ES256 ? 'ES256' : 'RS256'}`, async () => {
    const { a, reg, userId, signIn } = await registered({ alg });
    assert.equal(reg.credentialId, a.credentials[0].id);
    assert.equal(reg.alg, alg);
    assert.equal(reg.signCount, 0);
    assert.equal(reg.synced, true);
    assert.deepEqual(reg.transports, ['hybrid', 'internal']);
    assert.equal(reg.origin, ORIGIN);
    assert.equal(reg.rpId, 'localhost');
    const r = await signIn(await a.get({ challenge: CH }));
    assert.deepEqual(r, { signCount: 0, synced: true, userVerified: true, userHandle: userId, origin: ORIGIN, rpId: 'localhost' });
  });
}

test('the live origin, any origin in dev, and a device-bound passkey', async () => {
  const a = await softAuthenticator({ origin: 'https://nepet.github.io', synced: false });
  const reg = await verifyRegistration({ credential: await a.create({ challenge: CH }), challenge: CH, origins: null });
  assert.equal(reg.rpId, 'nepet.github.io');
  assert.equal(reg.synced, false);
  const r = await verifyAssertion({ credential: await a.get({ challenge: CH }), challenge: CH, origins: ORIGINS, publicKey: reg.publicKey, alg: reg.alg });
  assert.equal(r.synced, false);
  assert.equal(r.userHandle, null);
});

test('the sign counter must go up once it is counting', async () => {
  const { a, reg, signIn } = await registered({ counter: true });
  let stored = reg.signCount;
  for (let i = 1; i <= 3; i++) {
    const r = await signIn(await a.get({ challenge: CH }), { signCount: stored });
    assert.equal(r.signCount, i);
    stored = r.signCount;
  }
  const replay = await a.get({ challenge: CH });
  assert.equal((await signIn(replay, { signCount: stored })).signCount, stored + 1);
  await assert.rejects(signIn(replay, { signCount: stored + 1 }), code('counter'), 'replayed');
  await assert.rejects(signIn(await a.get({ challenge: CH }), { signCount: 99 }), code('counter'));
  // a synced passkey reports 0 and is never checked; a passkey that counted and now says 0 may be a copy
  const s = await registered({ counter: false });
  assert.equal((await s.signIn(await s.a.get({ challenge: CH }), { signCount: 0 })).signCount, 0);
  await assert.rejects(s.signIn(await s.a.get({ challenge: CH }), { signCount: 7 }), code('counter'));
});

test('DER signatures with padded, short and malformed integers', async () => {
  const raw = new Uint8Array(64).map((_, i) => i + 1);
  raw[0] = 0x80; raw[32] = 0;  // r needs a 0x00 prefix, s is one byte short
  const der = rawToDer(raw);
  assert.deepEqual([der[2], der[3], der[4]], [0x02, 33, 0x00]);
  assert.equal(der[4 + 33 + 1], 31);
  assert.deepEqual(derToRaw(der), raw);
  assert.deepEqual(derToRaw(rawToDer(new Uint8Array(64))), new Uint8Array(64));
  const bad = [
    new Uint8Array([0x31, ...der.subarray(1)]),           // not a SEQUENCE
    der.subarray(0, der.length - 1),                       // truncated
    new Uint8Array([...der, 0]),                           // trailing byte
    new Uint8Array([0x30, 6, 0x02, 1, 0x80, 0x02, 1, 1]),  // negative r
    new Uint8Array([0x30, 6, 0x02, 0, 0x02, 2, 1, 1]),     // empty r
    new Uint8Array([0x30, 38, 0x02, 34, ...new Uint8Array(34).fill(1), 0x02, 0])
  ];
  for (const b of bad) assert.throws(() => derToRaw(b), code('signature'));

  // real signatures whose r or s is shorter than 32 bytes still verify
  const { a, signIn } = await registered();
  let short = null;
  for (let i = 0; i < 3000 && !short; i++) {
    const cred = await a.get({ challenge: CH }), d = b64url.decode(cred.signature);
    if (d[3] < 32 || d[4 + d[3] + 1] < 32) short = cred;
  }
  assert.ok(short, 'found a short integer');
  await signIn(short);
});

test('authenticator data: flags, counter and attested credential id', () => {
  const b = new Uint8Array(55 + 3);
  b[32] = 0x01 | 0x04 | 0x08 | 0x10 | 0x40 | 0x80;
  b.set([0x01, 0x02, 0x03, 0x04], 33);
  b.set([0, 3, 9, 8, 7], 53);
  const p = parseAuthData(b);
  assert.deepEqual(p.flags, { up: true, uv: true, be: true, bs: true, at: true, ed: true });
  assert.equal(p.signCount, 0x01020304);
  assert.deepEqual(p.credentialId, new Uint8Array([9, 8, 7]));
  assert.equal(parseAuthData(new Uint8Array(37).fill(0xff, 33)).signCount, 0xffffffff);
  assert.throws(() => parseAuthData(new Uint8Array(36)), code('auth_data'));
  const at = l => { const x = new Uint8Array(55 + l); x[32] = 0x40; x[53] = l >> 8; x[54] = l & 255; return x; };
  assert.throws(() => parseAuthData(at(4).subarray(0, 58)), code('auth_data'), 'overruns');
  assert.throws(() => parseAuthData(at(1024)), code('auth_data'), 'too long');
  assert.throws(() => parseAuthData(at(0).subarray(0, 50)), code('auth_data'), 'no room for the header');
});

test('registration is refused for every broken check', async () => {
  const a = await softAuthenticator();
  const reg = cred => verifyRegistration({ credential: cred, challenge: CH, origins: ORIGINS });
  const make = opts => a.create({ challenge: CH, ...opts });
  const cases = [
    ['encoding', null],
    ['encoding', { ...await make(), clientDataJSON: 'a=b' }],
    ['client_data', { ...await make(), clientDataJSON: b64url.encode(new TextEncoder().encode('nope')) }],
    ['client_data', { ...await make(), clientDataJSON: b64url.encode(new TextEncoder().encode('{"type":"webauthn.create"}')) }],
    ['type', await make({ clientData: { type: 'webauthn.get' } })],
    ['challenge', await make({ challenge: 'other' })],
    ['origin', await make({ origin: 'https://evil.example' })],
    ['origin', await make({ origin: 'http://localhost:8788/' })],
    ['origin', await make({ clientData: { crossOrigin: true } })],
    ['rp_id', await make({ rpId: 'example.com' })],
    ['user_presence', await make({ flags: { up: false } })],
    ['auth_data', await make({ flags: { be: false, bs: true } })],
    ['auth_data', await make({ flags: { at: false } })],
    ['credential_id', { ...await make(), id: b64url.encode(new Uint8Array(16)) }],
    ['algorithm', { ...await make(), publicKeyAlgorithm: -8 }],
    ['algorithm', { ...await make(), publicKeyAlgorithm: '-7' }],
    ['public_key', { ...await make(), publicKey: b64url.encode(new Uint8Array(40)) }],
    ['public_key', { ...await make(), publicKey: b64url.encode(new Uint8Array(1025)) }],
    ['public_key', { ...await make(), publicKeyAlgorithm: RS256 }]
  ];
  for (const [c, cred] of cases) await assert.rejects(reg(cred), code(c), c);
  await assert.rejects(verifyRegistration({ credential: await make(), challenge: '', origins: null }), code('challenge'));
  await assert.rejects(verifyRegistration({ credential: await make({ origin: 'ftp://localhost' }), challenge: CH, origins: null }), code('origin'));
  const odd = await reg({ ...await make(), transports: ['usb', 5, '', 'x'.repeat(33), ...Array(10).fill('nfc')] });
  assert.deepEqual(odd.transports, ['usb', ...Array(7).fill('nfc')]);
  assert.deepEqual((await reg({ ...await make(), transports: 'usb' })).transports, []);
});

test('sign-in is refused for every broken check', async () => {
  const { a, signIn } = await registered();
  const get = opts => a.get({ challenge: CH, ...opts });
  const good = await get();
  const sig = b64url.decode(good.signature);
  const cases = [
    ['encoding', { ...good, signature: undefined }],
    ['encoding', { ...good, userHandle: '!!' }],
    ['type', await get({ clientData: { type: 'webauthn.create' } })],
    ['challenge', await get({ challenge: 'other' })],
    ['origin', await get({ origin: 'https://evil.example' })],
    ['origin', await get({ clientData: { crossOrigin: true } })],
    ['rp_id', await get({ rpId: 'example.com' })],
    ['user_presence', await get({ flags: { up: false } })],
    ['signature', { ...good, signature: b64url.encode(sig.subarray(1)) }],
    ['signature', { ...good, clientDataJSON: (await get({ clientData: { extra: 1 } })).clientDataJSON }],
    ['signature', { ...good, authenticatorData: (await get({ flags: { uv: false } })).authenticatorData }]
  ];
  for (const [c, cred] of cases) await assert.rejects(signIn(cred), code(c), c);
  const other = await registered();
  await assert.rejects(signIn(good, { publicKey: other.reg.publicKey }), code('signature'), 'another key');
  await assert.rejects(signIn(good, { alg: RS256 }), code('public_key'));
  await assert.rejects(signIn(good, { alg: -8 }), code('algorithm'));
  assert.equal((await signIn(await get({ flags: { uv: false } }))).userVerified, false);
});
