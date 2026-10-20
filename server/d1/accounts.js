/*
 * The player account store, over the { all, batch } interface from db.js:
 *   users      createUser (with the first passkey and session), getUser, renameUser, deleteUser
 *   passkeys   addPasskey, getPasskey, listPasskeys, touchPasskey, deletePasskey (never the last one)
 *   challenges putChallenge, takeChallenge (single use)
 *   sessions   createSession, sessionUser (sliding expiry), deleteSession, deleteSessions
 *   cleanup    purgeExpired
 * Times are milliseconds and passed in as `now`. Sessions are looked up by the SHA-256 hex of the token.
 */
export const SESSION_TTL_MS = 180 * 24 * 3600 * 1000;
export const SESSION_REFRESH_MS = 24 * 3600 * 1000; // write a session's new expiry at most this often
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const PASSKEY_COLS = 'id, user_id, public_key, alg, sign_count, transports, synced, created_at, last_used_at';

const insertPasskey = (userId, { id, publicKey, alg, signCount = 0, transports, synced }, now) => [
  'INSERT INTO passkeys (id, user_id, public_key, alg, sign_count, transports, synced, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  [id, userId, publicKey, alg, signCount, transports ? JSON.stringify(transports) : null, synced ? 1 : 0, now]
];
const insertSession = ({ hash, userId, now, expiresAt = now + SESSION_TTL_MS }) => [
  'INSERT INTO sessions (hash, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
  [hash, userId, now, expiresAt, now]
];
const passkey = r => ({
  id: r.id, userId: r.user_id, publicKey: r.public_key, alg: r.alg, signCount: r.sign_count,
  transports: r.transports ? JSON.parse(r.transports) : [], synced: !!r.synced, createdAt: r.created_at, lastUsedAt: r.last_used_at
});

export async function createUser(db, { id, name, now, passkey: key, session }) {
  await db.batch([
    ['INSERT INTO users (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, name, now, now]],
    insertPasskey(id, key, now),
    insertSession({ ...session, userId: id, now })
  ]);
}

export async function getUser(db, id) {
  const [r] = await db.all('SELECT id, name, created_at, updated_at FROM users WHERE id = ?', [id]);
  return r ? { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at } : null;
}

export async function renameUser(db, id, name, now) {
  await db.batch([['UPDATE users SET name = ?, updated_at = ? WHERE id = ?', [name, now, id]]]);
}

// stats rows keep the name and lose the link
export async function deleteUser(db, id) {
  await db.batch([
    ['UPDATE players SET user_id = NULL WHERE user_id = ?', [id]],
    ['DELETE FROM sessions WHERE user_id = ?', [id]],
    ['DELETE FROM passkeys WHERE user_id = ?', [id]],
    ['DELETE FROM auth_challenges WHERE user_id = ?', [id]],
    ['DELETE FROM users WHERE id = ?', [id]]
  ]);
}

export async function addPasskey(db, userId, key, now) {
  await db.batch([insertPasskey(userId, key, now)]);
}

export async function getPasskey(db, id) {
  const [r] = await db.all(`SELECT ${PASSKEY_COLS} FROM passkeys WHERE id = ?`, [id]);
  return r ? passkey(r) : null;
}

export async function listPasskeys(db, userId) {
  return (await db.all(`SELECT ${PASSKEY_COLS} FROM passkeys WHERE user_id = ? ORDER BY created_at, id`, [userId])).map(passkey);
}

// after a sign-in; synced left out keeps the stored flag
export async function touchPasskey(db, id, { signCount, synced, now }) {
  await db.batch([['UPDATE passkeys SET sign_count = ?, synced = COALESCE(?, synced), last_used_at = ? WHERE id = ?',
    [signCount, synced === undefined ? null : synced ? 1 : 0, now, id]]]);
}

// false when the passkey isn't the user's or is their last one; one statement, so two deletes can't remove both
export async function deletePasskey(db, userId, id) {
  const rows = await db.all(
    'DELETE FROM passkeys WHERE id = ? AND user_id = ? AND (SELECT COUNT(*) FROM passkeys WHERE user_id = ?) > 1 RETURNING id',
    [id, userId, userId]);
  return rows.length > 0;
}

export async function putChallenge(db, { id, challenge, purpose, userId = null, name = null, expiresAt }) {
  await db.batch([['INSERT INTO auth_challenges (id, challenge, purpose, user_id, name, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, challenge, purpose, userId, name, expiresAt]]]);
}

// single use: a challenge is deleted when taken, and an expired one gives null
export async function takeChallenge(db, id, now) {
  const [r] = await db.all('DELETE FROM auth_challenges WHERE id = ? RETURNING challenge, purpose, user_id, name, expires_at', [id]);
  return r && r.expires_at > now ? { challenge: r.challenge, purpose: r.purpose, userId: r.user_id, name: r.name } : null;
}

export async function createSession(db, session) {
  await db.batch([insertSession(session)]);
}

export async function sessionUser(db, hash, now, { ttl = SESSION_TTL_MS, refreshEvery = SESSION_REFRESH_MS } = {}) {
  const [r] = await db.all(
    'SELECT u.id, u.name, s.expires_at, s.last_used_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?', [hash]);
  if (!r || r.expires_at <= now) return null;
  if (now - r.last_used_at >= refreshEvery) {
    await db.batch([['UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE hash = ?', [now + ttl, now, hash]]]);
  }
  return { id: r.id, name: r.name };
}

export async function deleteSession(db, hash) {
  await db.batch([['DELETE FROM sessions WHERE hash = ?', [hash]]]);
}

export async function deleteSessions(db, userId) {
  await db.batch([['DELETE FROM sessions WHERE user_id = ?', [userId]]]);
}

export async function purgeExpired(db, now) {
  await db.batch([
    ['DELETE FROM auth_challenges WHERE expires_at <= ?', [now]],
    ['DELETE FROM sessions WHERE expires_at <= ?', [now]]
  ]);
}
