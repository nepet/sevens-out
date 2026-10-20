// A software passkey authenticator with real WebCrypto keys, for the WebAuthn and account tests.
//
//   const auth = await softAuthenticator({ alg: -7 | -257, origin, synced, counter })
//   await auth.create({ challenge, rpId?, userId? })                      -> registration payload (what the page POSTs)
//   await auth.get({ challenge, rpId?, userHandle?, credentialId? })      -> assertion payload
//
// counter: false (default) reports 0 like synced passkeys; true counts 1, 2, 3… per assertion.
// To tamper, both take { origin, flags: { up, uv, be, bs, at }, clientData: {…extra or overriding fields} };
// the signature still covers the tampered data, so only the intended check fails.
import { b64url } from '../server/core/webauthn.js';

const enc = new TextEncoder();
const random = n => crypto.getRandomValues(new Uint8Array(n));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// raw r||s -> DER, the way authenticators send ES256 signatures
export function rawToDer(raw) {
  const int = v => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.subarray(i);
    return v[0] & 0x80 ? [0x02, v.length + 1, 0, ...v] : [0x02, v.length, ...v];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

const KEYS = {
  [-7]: { name: 'ECDSA', namedCurve: 'P-256' },
  [-257]: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
};
const SIGN = { [-7]: { name: 'ECDSA', hash: 'SHA-256' }, [-257]: { name: 'RSASSA-PKCS1-v1_5' } };

export async function softAuthenticator({ alg = -7, origin = 'http://localhost:8788', synced = true, counter = false } = {}) {
  const credentials = [];
  let count = 0;

  const clientData = (type, challenge, o, extra) => b64url.encode(enc.encode(JSON.stringify({ type, challenge, origin: o, crossOrigin: false, ...extra })));
  async function authData(rpId, flags, attested) {
    const f = { up: true, uv: true, be: synced, bs: synced, at: !!attested, ...flags };
    const byte = (f.up && 0x01) | (f.uv && 0x04) | (f.be && 0x08) | (f.bs && 0x10) | (f.at && 0x40);
    const n = counter ? count : 0;
    const head = concat(
      new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(rpId))),
      new Uint8Array([byte, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
    );
    if (!attested) return head;
    // aaguid (zeros), credential id length, credential id, then a stand-in for the COSE key (an empty CBOR map)
    return concat(head, new Uint8Array(16), new Uint8Array([attested.length >> 8, attested.length & 255]), attested, new Uint8Array([0xa0]));
  }

  return {
    alg, origin, credentials,
    async create({ challenge, rpId, userId = null, origin: o = origin, flags, clientData: extra } = {}) {
      const keys = await crypto.subtle.generateKey(KEYS[alg], true, ['sign', 'verify']);
      const id = random(16);
      const cred = { id: b64url.encode(id), keys, userId, rpId: rpId || new URL(o).hostname };
      credentials.push(cred);
      return {
        id: cred.id,
        clientDataJSON: clientData('webauthn.create', challenge, o, extra),
        authenticatorData: b64url.encode(await authData(cred.rpId, flags, id)),
        publicKey: b64url.encode(await crypto.subtle.exportKey('spki', keys.publicKey)),
        publicKeyAlgorithm: alg,
        transports: ['hybrid', 'internal']
      };
    },
    async get({ challenge, rpId, userHandle, credentialId, origin: o = origin, flags, clientData: extra } = {}) {
      const cred = credentialId ? credentials.find(c => c.id === credentialId) : credentials[credentials.length - 1];
      if (!cred) throw new Error('no such credential');
      if (counter) count++;
      const cd = clientData('webauthn.get', challenge, o, extra);
      const ad = await authData(rpId || cred.rpId, flags, null);
      const signed = concat(ad, new Uint8Array(await crypto.subtle.digest('SHA-256', b64url.decode(cd))));
      let sig = new Uint8Array(await crypto.subtle.sign(SIGN[alg], cred.keys.privateKey, signed));
      if (alg === -7) sig = rawToDer(sig);
      return {
        id: cred.id, clientDataJSON: cd, authenticatorData: b64url.encode(ad), signature: b64url.encode(sig),
        userHandle: userHandle !== undefined ? userHandle : cred.userId
      };
    }
  };
}
