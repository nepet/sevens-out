// The admin page end to end: games played on the real page (Node server :8790) against the game Worker
// in wrangler dev (:8787) show up on the admin Worker (:8789). Tests share one database, so they run in order.
import { test, expect } from '@playwright/test';
import '../../engine.js';
import { sheetOf } from '../../server/core/stats.js';
import { quickGame } from '../games.js';
import { enterScore, live, net, noSideScroll } from './helpers.js';

const GAME = 'http://127.0.0.1:8787', ADMIN = 'http://127.0.0.1:8789', PAGE = 'http://127.0.0.1:8790';
const gameUrl = (p = '/') => `${PAGE}${p}${p.includes('?') ? '&' : '?'}server=${encodeURIComponent('ws://127.0.0.1:8787')}`;
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' };
test.describe.configure({ mode: 'serial' });

// the admin page, reloaded until `check` passes (games are written right after the last move)
async function adminShows(page, check, url = ADMIN) {
  await expect(async () => { await page.goto(url); await check(); }).toPass({ timeout: 15_000 });
}

test('with no games yet, every section says so', async ({ page }) => {
  await page.goto(ADMIN);
  await expect(page.locator('#activity .empty')).toHaveText('No games yet in this period.');
  await expect(page.locator('#facts .empty')).toHaveText('No games yet in this period.');
  await expect(page.locator('#leaderboard .empty')).toHaveText('No games yet in this period.');
  await expect(page.locator('#games .empty')).toHaveText('No finished games yet.');
  expect(await noSideScroll(page)).toBe(true);
});

test('an online game played to the end shows up', async ({ browser, page }) => {
  const A = await browser.newContext(phone), B = await browser.newContext(phone);
  const a = await A.newPage(), b = await B.newPage();
  await a.goto(gameUrl('/'));
  await a.click('[data-act=online]'); await a.fill('#oname', 'Anna'); await a.click('[data-act=ocreate]');
  await expect(a.locator('.roomcode')).toHaveText(/^[A-Z2-9]{5}$/);
  const code = await a.locator('.roomcode').innerText();
  await b.goto(gameUrl(`/?join=${code}`));
  await b.fill('#oname', 'Ben'); await b.click('[data-act=ojoin]');
  await expect(a.locator('.seat')).toHaveCount(2);
  await a.click('[data-act=omode][data-id="1"]');
  await a.click('[data-act=ostart]');
  await expect.poll(async () => (await live(a)) && (await live(a)).phase).toBe('play');
  const seatA = (await net(a)).seat;
  for (let guard = 0; guard < 20; guard++) {
    const st = await live(a);
    if (st.phase === 'over') break;
    const rev = (await net(a)).rev;
    if (st.phase === 'roundEnd') await a.click('[data-act=nextround]');
    else {
      const g = st.game, mine = g.seats[g.order[g.pos]] === seatA;
      await enterScore(mine ? a : b, mine ? 36 : 5, g.pos === 0 ? 1 : undefined); // Anna starts every round with 36
    }
    await expect.poll(async () => (await net(a)).rev).toBeGreaterThan(rev);
  }
  expect((await live(a)).phase).toBe('over');
  await A.close(); await B.close();

  await adminShows(page, async () => {
    await expect(page.locator('.tile[data-k=games] .v')).toHaveText('1');
    await expect(page.locator('#games .games li')).toHaveCount(1);
  });
  await expect(page.locator('#games .games li')).toContainText('Online');
  await expect(page.locator('#games .games li')).toContainText('Anna 108');
  await expect(page.locator('#games .games li')).toContainText('Ben 15');
});

test('a one-phone game finished while offline arrives after the next visit', async ({ browser, page }) => {
  const ctx = await browser.newContext(phone), p = await ctx.newPage();
  await p.goto(gameUrl('/'));
  await p.click('[data-act=mode][data-id="1"]');
  await p.fill('#name-0', 'Cleo'); await p.fill('#name-1', 'Dan');
  await p.click('[data-act=start]');
  for (let round = 1; round <= 3; round++) {
    await enterScore(p, 36, 1);
    if (round === 3) await ctx.setOffline(true);
    await enterScore(p, 7);
    if (round < 3) await p.click('[data-act=nextround]');
  }
  await expect(p.locator('.verdict')).toContainText('loses');
  await expect.poll(() => p.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-reports')).queue.length)).toBe(1);
  await ctx.setOffline(false);
  await p.reload();
  await expect.poll(() => p.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-reports')).queue.length)).toBe(0);
  await ctx.close();

  await adminShows(page, async () => { await expect(page.locator('#games .games li')).toHaveCount(2); });
  await expect(page.locator('#games .games li').first()).toContainText('One phone');
  await expect(page.locator('#games .games li').first()).toContainText('Cleo 108');
});

test('filters, leaderboard, a score sheet and deleting a game', async ({ page, request }) => {
  for (let i = 0; i < 3; i++) {
    const s = quickGame(['Anna', 'Ben']);
    const res = await request.post(`${GAME}/report`, {
      headers: { Origin: PAGE },
      data: { id: `00000000000000b${i}`, mode: 'score', startedAt: Date.now() - 900_000, finishedAt: Date.now() - (i + 1) * 60_000, sheet: sheetOf(s.game) }
    });
    expect(res.status()).toBe(204);
  }
  await page.goto(ADMIN);
  await expect(page.locator('.tile[data-k=games] .v')).toHaveText('5');

  // leaderboard: Anna and Ben have 4 games, Cleo and Dan 1 (hidden until "Show everyone")
  const rows = page.locator('#leaderboard tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('#leaderboard .switch')).toContainText('2 with fewer than 3 games hidden');
  await page.check('#show-all');
  await expect(rows).toHaveCount(4);
  const names = () => rows.locator('td:first-child').allInnerTexts();
  // losses: Anna 4, Cleo 1, Ben 0, Dan 0 (ties fall back to the name), which differs from the default order
  await page.click('[data-sort=losses]');
  await expect(page.locator('#leaderboard th[aria-sort=descending]')).toContainText('Losses');
  expect(await names()).toEqual(['Anna', 'Cleo', 'Ben', 'Dan']);
  await page.click('[data-sort=name]');
  await expect(page.locator('#leaderboard th[aria-sort=ascending]')).toContainText('Player');
  expect(await names()).toEqual(['Anna', 'Ben', 'Cleo', 'Dan']);
  await page.click('[data-sort=name]');
  await expect(page.locator('#leaderboard th[aria-sort=descending]')).toContainText('Player');
  expect(await names()).toEqual(['Dan', 'Cleo', 'Ben', 'Anna']);

  // filters, kept in the address
  await page.selectOption('#f-source', 'phone');
  await expect(page).toHaveURL(/source=phone/);
  await expect(page.locator('.tile[data-k=games] .v')).toHaveText('4');
  await expect(page.locator('.tile[data-k=abandoned] .v')).toHaveText('0');
  await page.selectOption('#f-mode', 'dice');
  await expect(page.locator('#activity .empty')).toHaveText('No games yet in this period.');
  await expect(page.locator('#games .empty')).toHaveText('No finished games yet.');
  await page.reload();
  await expect(page.locator('#f-mode')).toHaveValue('dice');
  await page.selectOption('#f-mode', '');
  await page.selectOption('#f-source', '');

  // open a game and delete it
  const games = page.locator('#games .games li');
  await expect(games).toHaveCount(5);
  await games.first().locator('button').click();
  const sheet = page.locator('#sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('table')).toContainText('Total');
  await sheet.locator('[data-act=delete]').click();
  await sheet.locator('[data-act=delete-no]').click();
  await expect(sheet.locator('[data-act=delete]')).toBeVisible();
  await sheet.locator('[data-act=delete]').click();
  await sheet.locator('[data-act=delete-yes]').click();
  await expect(sheet).toBeHidden();
  await expect(games).toHaveCount(4);
  await expect(page.locator('.tile[data-k=games] .v')).toHaveText('4');
  expect(await noSideScroll(page)).toBe(true);
});

test('when the API cannot be reached, the page says how to fix it', async ({ page }) => {
  await page.route('**/api/**', route => route.abort('internetdisconnected'));
  await page.goto(ADMIN);
  await expect(page.locator('#activity .err')).toHaveText("Couldn't reach the admin page. Reload to sign in again.");
  await expect(page.locator('#games .err')).toHaveText("Couldn't reach the admin page. Reload to sign in again.");
});
