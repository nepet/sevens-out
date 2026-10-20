/*
 * Passkey (WebAuthn) checks, independent of where they run: only crypto.subtle, TextEncoder/TextDecoder
 * and atob/btoa, which Workers and Node 22+ both have.
 *
 * Attestation is 'none', so registration trusts the browser's getPublicKey() (SPKI) and
 * getPublicKeyAlgorithm() instead of parsing the CBOR key: a client that lies only locks itself out.
 * All binary fields are base64url without padding.
 *
 *   verifyRegistration({ credential, challenge, origins }) -> { credentialId, publicKey, alg, signCount, synced, transports, origin, rpId }
 *     credential = { id, clientDataJSON, authenticatorData, publicKey, publicKeyAlgorithm, transports? }
 *   verifyAssertion({ credential, challenge, origins, publicKey, alg, signCount }) -> { signCount, synced, userVerified, userHandle, origin, rpId }
 *     credential = { id, clientDataJSON, authenticatorData, signature, userHandle? }; the caller looks up
 *     the passkey by credential.id and checks userHandle against its owner
 *   origins: allowed origins (exact match), or null = any http(s) origin (dev). The RP ID is the origin's hostname.
 *   Both throw WebAuthnError with a short .code: encoding, client_data, type, challenge, origin, rp_id,
 *   user_presence, auth_data, credential_id, algorithm, public_key, signature, counter.
 *
 *   parseAuthData(bytes) -> { rpIdHash, flags: { up, uv, be, bs, at, ed }, signCount, credentialId? }
 *   derToRaw(der) -> 64-byte r||s for an ES256 signature, b64url.encode / b64url.decode
 */

export const ES256 = -7, RS256 = -257;
export const MAX_FIELD = 8192;       // characters in one base64url field
export const MAX_PUBLIC_KEY = 1024;  // bytes of SPKI
const MAX_CRED_ID = 1023, MAX_TRANSPORTS = 8, MAX_TRANSPORT_LEN = 32;
const IMPORT = {
  [ES256]: { name: 'ECDSA', namedCurve: 'P-256' },
  [RS256]: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
};
const VERIFY = { [ES256]: { name: 'ECDSA', hash: 'SHA-256' }, [RS256]: { name: 'RSASSA-PKCS1-v1_5' } };

export class WebAuthnError extends Error {
  constructor(code, message = code) { super(message); this.name = 'WebAuthnError'; this.code = code; }
}
const fail = (code, message) => { throw new WebAuthnError(code, message); };

const bytesOf = b => b instanceof Uint8Array ? b : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);

export const b64url = {
  encode(bytes) {
    const u = bytesOf(bytes);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) fail('encoding', 'not base64url');
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

function field(cred, key, { optional = false } = {}) {
  const v = cred[key];
  if (optional && v == null) return null;
  if (typeof v !== 'string' || !v || v.length > MAX_FIELD) fail('encoding', `bad ${key}`);
  return b64url.decode(v);
}

export function parseAuthData(bytes) {
  const b = bytesOf(bytes);
  if (b.length < 37) fail('auth_data', 'authenticator data too short');
  const f = b[32];
  const flags = { up: !!(f & 0x01), uv: !!(f & 0x04), be: !!(f & 0x08), bs: !!(f & 0x10), at: !!(f & 0x40), ed: !!(f & 0x80) };
  const out = { rpIdHash: b.slice(0, 32), flags, signCount: ((b[33] << 24) >>> 0) + (b[34] << 16) + (b[35] << 8) + b[36] };
  if (flags.at) {
    // attested credential data: aaguid (16), credential id length (u16 BE), credential id, COSE key (not needed)
    if (b.length < 55) fail('auth_data', 'attested credential data too short');
    const len = (b[53] << 8) | b[54];
    if (len > MAX_CRED_ID || 55 + len > b.length) fail('auth_data', 'bad credential id length');
    out.credentialId = b.slice(55, 55 + len);
  }
  return out;
}

// ES256 signatures come as DER SEQUENCE { INTEGER r, INTEGER s }; WebCrypto wants r||s, 32 bytes each
export function derToRaw(der) {
  const b = bytesOf(der);
  if (b.length < 8 || b[0] !== 0x30 || b[1] !== b.length - 2) fail('signature', 'bad DER signature');
  const raw = new Uint8Array(64);
  let at = 2;
  for (const off of [0, 32]) {
    if (b[at] !== 0x02) fail('signature', 'bad DER signature');
    const len = b[at + 1];
    if (!len || len > 33 || at + 2 + len > b.length || b[at + 2] & 0x80) fail('signature', 'bad DER signature');
    let v = b.subarray(at + 2, at + 2 + len);
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) fail('signature', 'bad DER signature');
    raw.set(v, off + 32 - v.length);
    at += 2 + len;
  }
  if (at !== b.length) fail('signature', 'bad DER signature');
  return raw;
}

async function importKey(spki, alg) {
  if (!IMPORT[alg]) fail('algorithm', 'unsupported algorithm');
  try { return await crypto.subtle.importKey('spki', spki, IMPORT[alg], false, ['verify']); }
  catch { fail('public_key', 'public key does not import'); }
}

function checkOrigin(origin, origins) {
  let url;
  try { url = new URL(origin); } catch { fail('origin', 'bad origin'); }
  if (!/^https?:$/.test(url.protocol) || url.origin !== origin) fail('origin', 'bad origin');
  if (origins && !origins.includes(origin)) fail('origin', 'origin not allowed');
  return url.hostname;
}

// the checks both ceremonies share: client data, origin, RP ID hash, user presence
async function common(credential, type, challenge, origins) {
  if (!credential || typeof credential !== 'object') fail('encoding', 'no credential');
  const cdBytes = field(credential, 'clientDataJSON');
  const authBytes = field(credential, 'authenticatorData');
  let cd;
  try { cd = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cdBytes)); } catch { fail('client_data', 'client data is not JSON'); }
  if (!cd || typeof cd !== 'object' || typeof cd.type !== 'string' || typeof cd.challenge !== 'string' || typeof cd.origin !== 'string') fail('client_data', 'client data is incomplete');
  if (cd.type !== type) fail('type', `expected ${type}`);
  if (typeof challenge !== 'string' || !challenge || cd.challenge !== challenge) fail('challenge', 'challenge does not match');
  if (cd.crossOrigin === true) fail('origin', 'cross-origin request');
  const rpId = checkOrigin(cd.origin, origins);
  const auth = parseAuthData(authBytes);
  if (!same(auth.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) fail('rp_id', 'RP ID hash does not match');
  if (!auth.flags.up) fail('user_presence', 'user not present');
  if (auth.flags.bs && !auth.flags.be) fail('auth_data', 'backed up but not backup eligible');
  return { cdBytes, authBytes, auth, origin: cd.origin, rpId };
}

export async function verifyRegistration({ credential, challenge, origins = null }) {
  const { auth, origin, rpId } = await common(credential, 'webauthn.create', challenge, origins);
  if (!auth.flags.at) fail('auth_data', 'no attested credential data');
  const id = field(credential, 'id');
  if (!same(auth.credentialId, id)) fail('credential_id', 'credential id does not match');
  const alg = credential.publicKeyAlgorithm;
  if (alg !== ES256 && alg !== RS256) fail('algorithm', 'unsupported algorithm');
  const spki = field(credential, 'publicKey');
  if (spki.length > MAX_PUBLIC_KEY) fail('public_key', 'public key too large');
  await importKey(spki, alg);
  const transports = (Array.isArray(credential.transports) ? credential.transports : [])
    .filter(t => typeof t === 'string' && t && t.length <= MAX_TRANSPORT_LEN).slice(0, MAX_TRANSPORTS);
  return { credentialId: b64url.encode(id), publicKey: b64url.encode(spki), alg, signCount: auth.signCount, synced: auth.flags.bs, transports, origin, rpId };
}

export async function verifyAssertion({ credential, challenge, origins = null, publicKey, alg, signCount = 0 }) {
  const { cdBytes, authBytes, auth, origin, rpId } = await common(credential, 'webauthn.get', challenge, origins);
  const key = await importKey(b64url.decode(publicKey), alg);
  let sig = field(credential, 'signature');
  if (alg === ES256) sig = derToRaw(sig);
  const userHandle = field(credential, 'userHandle', { optional: true });
  const signed = concat(authBytes, await sha256(cdBytes));
  if (!await crypto.subtle.verify(VERIFY[alg], key, sig, signed)) fail('signature', 'signature does not verify');
  const stored = signCount || 0;
  if (stored && auth.signCount <= stored) fail('counter', 'sign counter went backwards');
  return {
    signCount: Math.max(stored, auth.signCount), synced: auth.flags.bs, userVerified: auth.flags.uv,
    userHandle: userHandle && b64url.encode(userHandle), origin, rpId
  };
}
