// Shared helpers for the browser tests.
import { expect } from '@playwright/test';

// TARGET=worker points online play at `wrangler dev` instead of the Node server that serves the page
export const SERVER = process.env.TARGET === 'worker' ? 'ws://127.0.0.1:8787' : '';
export const url = (p = '/') => SERVER ? `${p}${p.includes('?') ? '&' : '?'}server=${encodeURIComponent(SERVER)}` : p;

// the phone's own saved game (pass-and-play)
export const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-v1')));
// what the page is showing right now (works online too)
export const live = page => page.evaluate(() => window.SevensDebug.state);
export const net = page => page.evaluate(() => window.SevensDebug.net);
export const idle = page => expect.poll(() => page.evaluate(() => window.SevensDebug.busy)).toBe(false);
// between rounds: tap the race away if it plays, then wait until the page is idle. A Sevens Out celebration
// or a missed-7 joke from the round's last turn plays first, so wait for the race while the page is busy.
export async function skipRace(page) {
  const race = page.locator('.race');
  await expect.poll(async () => (await race.isVisible()) || !(await page.evaluate(() => window.SevensDebug.busy))).toBe(true);
  if (await race.isVisible()) await race.click({ timeout: 2000 }).catch(() => {}); // it may just have ended by itself
  await idle(page);
}

// a dice turn with no rolls left: End while a 7 is still on the table (you find the 7s); otherwise the roll ended the
// turn by itself, and while the throw lies on the mat the bar says who is next: a tap on it goes on at once. When the
// page is idle without either, the turn has already moved on. Online the roll goes to the server first: until its
// answer (the next revision) the page isn't busy yet, so it waits for that too
export async function endTurn(page) {
  const end = page.locator('.bar [data-act=end]'), hand = page.locator('.bar .handoff');
  const rev = await page.evaluate(() => window.SevensDebug.net.code ? window.SevensDebug.net.rev : null);
  await expect.poll(async () => (await end.count()) + (await hand.count()) > 0
    || (await page.evaluate(r => !window.SevensDebug.busy && (r === null || window.SevensDebug.net.rev > r), rev))).toBe(true);
  if (await end.count()) await end.click();
  else if (await hand.count()) await hand.click({ timeout: 2000 }).catch(() => {}); // it may just have gone on by itself
}

// make the first dice the page rolls come up as `faces` (1-6); byte b gives face b % 6 + 1
export async function fixDice(context, faces) {
  const bytes = JSON.stringify(faces.map(f => f - 1));
  await context.addInitScript(`(() => { const seq = ${bytes}; let i = 0; const orig = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = a => { if (a.length === 1 && i < seq.length) { a[0] = seq[i++]; return a; } return orig(a); }; })();`);
}

// home → Play sheet (at this table, the dice and the 7s switch) → Who's playing
export async function toPlayers(page, { mode = 'dice', pairing = 'manual' } = {}) {
  await page.click('[data-act=play]');
  await expect(page.locator('.sheet-layer .sheet')).toBeVisible();
  if (await page.locator('[data-act=where][data-id="0"]').count()) await page.click('[data-act=where][data-id="0"]');
  await page.click(`[data-act=mode][data-id="${mode === 'score' ? 1 : 0}"]`);
  if (mode !== 'score' && (await page.locator('[data-act=pairing]').getAttribute('aria-checked')) !== String(pairing === 'auto')) await page.click('[data-act=pairing]');
  await page.click('[data-act=players]');
  await expect(page.locator('[data-act=start]')).toBeVisible();
}
// your player (home's profile chip; only where accounts are available): the Profile screen, which holds only the account
export async function openProfile(page) {
  await page.click('.home-head [data-act=profile]');
  await expect(page.locator('#profile-h')).toBeVisible();
}
// home's Settings sheet: Sound, Look, Shake, then How to play and Developer as folds; `fold` also opens one ('rules', 'dev')
export async function openSettings(page, fold) {
  if (!(await page.locator('.sheet-layer').isVisible())) await page.click('.home-head [data-act=settings]');
  await expect(page.locator('.sheet-layer .sheet')).toBeVisible();
  await expect(page.locator('#sheet-h')).toHaveText('Settings');
  if (fold) {
    const d = page.locator(`.sheet-layer details[data-fold=${fold}]`);
    if (!(await d.evaluate(el => el.open))) await d.locator('summary').click();
  }
}

export async function startLocal(page, { names = ['Anna', 'Ben'], mode = 'dice', pairing = 'manual', starter = 0 } = {}) {
  await page.goto('/');
  await toPlayers(page, { mode, pairing });
  for (let i = 2; i < names.length; i++) await page.click('[data-act=add]');
  for (let i = 0; i < names.length; i++) await page.fill(`#name-${i}`, names[i]);
  if (starter) await page.check(`#starter-${starter}`);
  await page.click('[data-act=start]');
}

// scoreboard: type a score and (for the starter) the rolls used, then save
export async function enterScore(page, pts, rolls) {
  await closeScores(page);                                            // a tap on the mat would only close the open list
  await page.click('[data-act=clear]');
  for (const ch of String(pts)) await page.click(`[data-act=key][data-id="${ch}"]`);
  if (rolls) await page.click(`[data-act=rolls][data-id="${rolls}"]`);
  await page.click('[data-act=commit]');
}

// check a finished game's score sheet against every rule; returns the totals
export function checkSheet(g) {
  const n = g.players.length, scores = Array(n).fill(0), at = Array(n).fill(-1);
  let seq = 0, prev = null, order = [];
  g.rounds.forEach((rd, ri) => {
    if (ri) {
      const mx = Math.max(...scores), tied = scores.map((_, i) => i).filter(i => scores[i] === mx);
      const first = Math.min(...tied.map(i => at[i])), early = tied.filter(i => at[i] === first);
      let exp = early[0];
      if (early.length > 1) for (let k = 1; k <= n; k++) { const i = (prev + k) % n; if (early.includes(i)) { exp = i; break; } }
      expect(rd.starter, `round ${rd.no} starter`).toBe(exp);
    }
    order = Array.from({ length: n }, (_, k) => (rd.starter + k) % n);
    const mark = rd.results[rd.starter] && rd.results[rd.starter].rolls;
    for (const p of order) {
      const r = rd.results[p];
      if (g.mode === 'dice') expect(r.rolls).toBeLessThanOrEqual(mark);
      seq++; if (r.pts > 0) at[p] = seq; scores[p] += r.pts;
    }
    if (ri < g.rounds.length - 1) expect(Math.max(...scores)).toBeLessThan(101);
    prev = rd.starter;
  });
  expect(scores).toEqual(g.players.map(p => p.score));
  let L = null; for (const i of order) if (L === null || scores[i] >= scores[L]) L = i;
  expect(g.loser).toBe(L);
  return scores;
}

// Math.random from a seed (the dice's spots use it; the dice faces come from crypto). Set it up before goto
export const seedRandom = (page, seed) => page.addInitScript(sd => {
  let a = sd;
  Math.random = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}, seed);
export const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// ----- passkeys (your player) -----
// WebAuthn refuses IP addresses as the relying party ID, so account tests open the page on localhost, not 127.0.0.1
export const LOCAL = 'http://localhost:8790';
export const localUrl = (p = '/') => LOCAL + url(p);
export const account = page => page.evaluate(() => window.SevensDebug.account);
// where /auth answers: the page's own server, or wrangler dev with TARGET=worker
export const AUTH = SERVER ? SERVER.replace(/^ws/, 'http') : LOCAL;
// the account this phone keeps for AUTH ({ token, id, name }), or null; accounts are stored per server
export const storedAccount = (page, server = AUTH) => page.evaluate(k => (JSON.parse(localStorage.getItem('sevens-out-account')) || {})[k] || null, server);

// a virtual platform authenticator (like Face ID / a fingerprint) that says yes at once
export async function addAuthenticator(page, options = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true, ...options } });
  return { cdp, authenticatorId };
}
export const credentials = async ({ cdp, authenticatorId }) => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
// the same synced passkey on another phone: copy a credential (with its private key) into another authenticator
export async function copyCredential(from, to, credential = null) {
  const c = credential || (await credentials(from))[0];
  await to.cdp.send('WebAuthn.addCredential', { authenticatorId: to.authenticatorId, credential: c });
  return c;
}

// ----- the game menu (play screens and the lobby) -----
// open it from the header's menu button; `fold` also opens one of its folds ('sheet', 'rules', 'dev')
export async function openMenu(page, fold) {
  if (!(await page.locator('.sheet-layer').isVisible())) await page.click('[data-act=menu]');
  await expect(page.locator('.sheet-layer .sheet')).toBeVisible();
  if (fold) {
    const d = page.locator(`.sheet-layer details[data-fold=${fold}]`);
    if (!(await d.evaluate(el => el.open))) await d.locator('summary').click();
  }
}
export async function closeMenu(page) {
  if (await page.locator('.sheet-layer').isVisible()) await page.keyboard.press('Escape');
  await expect(page.locator('.sheet-layer')).toBeHidden();
}

// ----- the dice turn (C4) -----
// the score chip shows every total; a tap opens the full score list (section.board) under it, over the mat
export async function openScores(page) {
  const chip = page.locator('#app .scorechip');
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#app .scores-pop .board')).toBeVisible();
}
// close the score list opened from the chip (Escape), when it is open
export async function closeScores(page) {
  const chip = page.locator('#app .scorechip');
  if (!(await chip.count()) || (await chip.getAttribute('aria-expanded')) !== 'true') return;
  await page.keyboard.press('Escape');
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
}
// real dice: open corrections for player i from their line in the score list (on the turn screen the list
// opens from the chip first; game over shows it on the page)
export async function editLine(page, i) {
  if (await page.locator('#app .scorechip').count()) await openScores(page);
  await page.click(`#app .board .pl[data-act=edit][data-id="${i}"]`);
  await expect(page.locator('#edit-h')).toBeVisible();
}
// the points a stop would book right now, as the bar's Stop or End button shows them
export const stopPts = page => page.locator('#app > .bar :is([data-act=stop], [data-act=end]) small');

// ----- a fake room server (online play without the real one) -----
// page.routeWebSocket answers the page's hello with welcome, the chat log (only when `log` is given: null or left out
// is an old server that doesn't speak chat) and the room; push(m) sends any message to the page, close() drops the socket
// (the page reconnects, and the next hello gets the same answers), hellos() counts the hellos, sent() lists the page's
// other messages ({t:'chat', text}, …), and set(o) changes the answers to the next hellos (o: any of room, state, seat,
// viewer, log). viewer: a spectator's own id in welcome (seat null). Set it up before goto
export async function fakeRoom(page, opts) {
  const o = { state: null, ...opts };
  let sock = null, hellos = 0;
  const sent = [];
  await page.routeWebSocket(/\/room\//, ws => {
    sock = ws;
    ws.onMessage(raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.t !== 'hello') { sent.push(m); return; }
      hellos++;
      ws.send(JSON.stringify({ t: 'welcome', seat: o.seat, token: 't', ...(o.viewer ? { viewer: o.viewer } : {}) }));
      if (o.log != null) ws.send(JSON.stringify({ t: 'chat', log: o.log }));
      ws.send(JSON.stringify({ t: 'room', rev: 1, room: o.room, state: o.state, events: [] }));
    });
  });
  return { push: m => { if (sock) sock.send(JSON.stringify(m)); }, close: () => { if (sock) sock.close(); }, hellos: () => hellos,
    sent: () => sent, set: x => Object.assign(o, x) };
}

// the chip's content fits inside it on one line (nothing cut off, nothing wrapped)
export const chipFits = async page => {
  const c = page.locator('#app .scorechip');
  const [sw, cw, h] = await c.evaluate(el => [el.scrollWidth, el.clientWidth, el.getBoundingClientRect().height]);
  expect(sw, 'chip content fits').toBeLessThanOrEqual(cw + 0.5);
  expect(h).toBeCloseTo(44, 0);
  const tops = await c.locator('.sc-p').evaluateAll(ps => ps.map(p => Math.round(p.getBoundingClientRect().top)));
  expect(new Set(tops).size, 'one line').toBe(1);
  // every name stub and total lies inside the chip's box: nothing is cut off by its overflow:hidden
  const cut = await c.evaluate(el => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll('.sc-p, .sc-p b')].filter(x => {
      const r = x.getBoundingClientRect();
      return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5;
    }).map(x => x.textContent);
  });
  expect(cut, 'chip items inside the chip').toEqual([]);
};
