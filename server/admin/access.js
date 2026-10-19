/*
 * Cloudflare Access sign-in check for the admin Worker.
 * Access signs the owner in and adds a signed token (JWT, RS256) in the Cf-Access-Jwt-Assertion header.
 * The Worker checks it too, so a mistake in the Access settings locks the page instead of opening it.
 */
const KEYS_TTL_MS = 60 * 60 * 1000;
let cached = { team: null, at: 0, keys: null };

export async function accessKeys(team, { fetcher = fetch, now = Date.now() } = {}) {
  if (cached.team === team && now - cached.at < KEYS_TTL_MS) return cached.keys;
  const res = await fetcher(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access keys: HTTP ${res.status}`);
  const { keys } = await res.json();
  if (!Array.isArray(keys)) throw new Error('Access keys: none in the answer');
  cached = { team, at: now, keys };
  return keys;
}

const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
const decodeJson = s => JSON.parse(new TextDecoder().decode(fromB64url(s)));

export async function verifyAccess(token, { team, aud, keys, now = Date.now() }) {
  if (!token) return { error: 'missing' };
  const parts = String(token).split('.');
  if (parts.length !== 3) return { error: 'malformed' };
  let header, payload;
  try { header = decodeJson(parts[0]); payload = decodeJson(parts[1]); } catch { return { error: 'malformed' }; }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') return { error: 'malformed' };
  if (header.alg !== 'RS256') return { error: 'algorithm' };
  // The key id must be a real string, so a key without a kid never matches a token without one.
  const jwk = typeof header.kid === 'string' && Array.isArray(keys) ? keys.find(k => k && k.kid === header.kid) : null;
  if (!jwk) return { error: 'unknown_key' };
  let ok = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { ok = false; }
  if (!ok) return { error: 'signature' };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud || !auds.includes(aud)) return { error: 'audience' };
  // An unset team must never produce a matching issuer.
  if (!team || payload.iss !== `https://${team}.cloudflareaccess.com`) return { error: 'issuer' };
  const t = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || !(payload.exp > t)) return { error: 'expired' };
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > t + 60)) return { error: 'not_yet_valid' };
  return { ok: true, email: typeof payload.email === 'string' ? payload.email : null };
}
