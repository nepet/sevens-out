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

// make the first dice the page rolls come up as `faces` (1-6); byte b gives face b % 6 + 1
export async function fixDice(context, faces) {
  const bytes = JSON.stringify(faces.map(f => f - 1));
  await context.addInitScript(`(() => { const seq = ${bytes}; let i = 0; const orig = crypto.getRandomValues.bind(crypto);
    crypto.getRandomValues = a => { if (a.length === 1 && i < seq.length) { a[0] = seq[i++]; return a; } return orig(a); }; })();`);
}

export async function startLocal(page, { names = ['Anna', 'Ben'], mode = 'dice', starter = 0 } = {}) {
  await page.goto('/');
  if (mode === 'score') await page.click('[data-act=mode][data-id="1"]');
  for (let i = 2; i < names.length; i++) await page.click('[data-act=add]');
  for (let i = 0; i < names.length; i++) await page.fill(`#name-${i}`, names[i]);
  if (starter) await page.check(`#starter-${starter}`);
  await page.click('[data-act=start]');
}

// scoreboard: type a score and (for the starter) the rolls used, then save
export async function enterScore(page, pts, rolls) {
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

export const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
