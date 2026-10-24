// Schocken in the browser: the game choice, the dice turn (setting aside, turning a 6 into a 1, blind), the fit on a
// small phone, real dice to game over, and two phones online. Runs against the Node server (npm run test:e2e), the
// online test also with TARGET=worker.
import { test, expect } from '@playwright/test';
import { url, live, idle, skipRace, fixDice, noSideScroll, openMenu, closeMenu, openScores, closeScores } from './helpers.js';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

// home → Play sheet (Schocken, at this table, the dice) → Who's playing → Start
async function startSK(page, { names = ['Anna', 'Ben'], mode = 'dice' } = {}) {
  await page.goto(url('/'));
  await page.click('[data-act=play]');
  await expect(page.locator('.sheet-layer .cards.three [data-act=kind]')).toHaveCount(3);
  await page.click('[data-act=kind][data-id="2"]');
  await expect(page.locator('[data-act=kind][data-id="2"]')).toHaveAttribute('aria-pressed', 'true');
  if (await page.locator('[data-act=where][data-id="0"]').count()) await page.click('[data-act=where][data-id="0"]');
  await page.click(`[data-act=mode][data-id="${mode === 'score' ? 1 : 0}"]`);
  await expect(page.locator('.sheet-layer [data-act=pairing]')).toHaveCount(0); // no 7s in Schocken
  await page.click('[data-act=players]');
  await expect(page.locator('.moderow')).toContainText(`Schocken · ${mode === 'score' ? 'Real dice' : 'Dice in the app'}`);
  for (let i = 2; i < names.length; i++) await page.click('[data-act=add]');
  for (let i = 0; i < names.length; i++) await page.fill(`#name-${i}`, names[i]);
  await page.click('[data-act=start]');
}
// one real-dice turn: the three dice, the rolls used (left out when only one is allowed) and the switches
async function enterThrow(page, dice, rolls, { blind = false } = {}) {
  await closeScores(page);
  await page.click('[data-act=clear]');
  for (const d of dice) await page.click(`[data-act=key][data-id="${d}"]`);
  if (rolls) await page.click(`[data-act=rolls][data-id="${rolls}"]`);
  if (blind) await page.click('[data-act=skblind]');
  await page.click('[data-act=commit]');
}
const mat = page => page.locator('#app .mat .dice');
const tray = page => page.locator('#app .tray');
const hint = page => page.locator('#app .mat-foot .hint');

test('the dice turn: turn two 6s into a 1, set aside, stop; then a blind roll comes up at the end of the round and doubles', async ({ page, context }) => {
  // Anna: 6 6 3, turns a 6 into a 1, sets the 3 aside, rolls the other 6: 1 → Schock 3. Ben rolls blind: 2 2 1
  await fixDice(context, [6, 6, 3, 1, 2, 2, 1]);
  await startSK(page);
  let s = await live(page);
  expect([s.game.kind, s.game.pot, s.game.turn.dice.length]).toEqual(['schocken', 13, 3]);
  await expect(page.locator('#app .eyebrow')).toHaveText('1st half · Pot 13 · Sets the limit');
  await expect(page.locator('#app .tobeat')).toHaveText('First throw of the round: nothing to beat yet.');
  await expect(tray(page).locator('[data-act=blind]')).toBeVisible(); // blind works from the first roll on
  await page.click('[data-act=roll]');
  await expect(mat(page).locator('.die')).toHaveCount(3);
  await expect(page.locator('#app .throwcell b')).toHaveText('663');
  await expect(hint(page)).toHaveText('Two 6s: turn one into a 1, or play on.');
  await page.click('[data-act=flip]');
  await expect(tray(page).locator('button.die')).toHaveAttribute('aria-label', 'Turn the 1 back into a 6');
  await expect(hint(page)).toHaveText('A 6 turned into a 1. The other 6 goes back into the cup.');
  await expect(page.locator('#app .stopc')).toBeDisabled();
  await mat(page).locator('[aria-label="Die showing 6"]').click();
  await expect(hint(page)).toHaveText('This 6 goes back into the cup: roll it.');
  await mat(page).locator('[aria-label="Die showing 3"]').click();
  await expect(tray(page).locator('.die')).toHaveCount(2);
  await expect(page.locator('#app .rollbtn small')).toHaveText('1 die');
  await page.click('[data-act=roll]');
  await expect(page.locator('#app .throwcell b')).toHaveText('Sch 3');
  await expect(page.locator('#app .eyebrow')).toHaveText('1st half · Pot 13 · Roll 2 of 3');
  await expect(tray(page).locator('button.die')).toHaveCount(0); // set aside in an earlier roll
  await page.click('[data-act=stop]');
  await expect(hint(page)).toHaveText('Everyone gets 2 rolls. Tap again to stop.');
  await page.click('[data-act=stop]');
  await expect(page.locator('#app .who')).toContainText('Ben');
  await expect(page.locator('#app .eyebrow')).toHaveText('1st half · Pot 13 · Up to 2 rolls');
  await expect(page.locator('#app .tobeat')).toHaveText('To beat: Anna · Schock 3 in 2 rolls');
  // Blind asks once more, then ends the turn with the cup down
  await page.click('[data-act=blind]');
  await expect(tray(page).locator('[data-act=blind]')).toHaveText('Sure?');
  await expect(hint(page)).toContainText('Roll blind: the cup stays down until the round ends');
  await page.click('[data-act=blind]');
  await skipRace(page);
  s = await live(page);
  expect(s.game.rounds[0].results[1]).toEqual({ dice: [2, 2, 1], kept: [], hand: true, rolls: 1, blind: true, pts: 1 });
  expect([s.game.rounds[0].loser, s.game.rounds[0].take, s.game.pot]).toEqual([1, 6, 7]); // Schock 3 doubled: Ben's lowest was blind
  expect(s.game.players.map(p => p.score)).toEqual([0, 6]);
  expect(s.game.starter).toBe(1); // the loser starts the next round
  await expect(page.locator('#app .who')).toContainText('Ben');
  await expect(page.locator('#app .scorechip')).toHaveAttribute('aria-label', 'Coasters: Ben 6, Anna 0');
  await openScores(page);
  await expect(page.locator('#app .scores-pop .bhead')).toContainText('1st half · pot 7');
  await closeScores(page);
  await openMenu(page, 'sheet');
  await expect(page.locator('.sheet-layer table td.lc')).toHaveText('221 +61×');
  await expect(page.locator('.sheet-layer details[data-fold=rules] summary')).toHaveText('How to play Schocken');
  await closeMenu(page);
  expect(await noSideScroll(page)).toBe(true);
});

test('the dice turn fits a small phone: the dice, the tray with its tools and the bar', async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await fixDice(context, [6, 6, 2]);
  await startSK(page, { names: ['Anna', 'Ben', 'Cleo', 'Dan', 'Eve', 'Finn'] });
  await page.click('[data-act=roll]');
  await mat(page).locator('[aria-label="Die showing 2"]').click();
  await expect(tray(page).locator('[data-act=flip]')).toBeVisible();
  await expect(tray(page).locator('[data-act=blind]')).toBeVisible();
  const inView = sel => page.locator(sel).evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
  for (const sel of ['#app [data-act=stop]', '#app [data-act=roll]', '#app .throwcell', '#app .tray', '#app [data-act=flip]', '#app [data-act=blind]', '#app .tobeat']) expect(await inView(sel), sel).toBe(true);
  for (const h of await tray(page).locator('.btn, button.die').evaluateAll(bs => bs.map(b => b.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  const trayTop = await tray(page).evaluate(el => el.getBoundingClientRect().top);
  const bottoms = await mat(page).locator('.die').evaluateAll(ds => ds.map(d => d.getBoundingClientRect().bottom));
  expect(bottoms).toHaveLength(2);
  for (const b of bottoms) expect(b).toBeLessThanOrEqual(trayTop);
  expect(await noSideScroll(page)).toBe(true);
});

test('real dice: three dice, the rolls used within the limit, from one roll, blind, and Schock out ends the halves', async ({ page }) => {
  await startSK(page, { mode: 'score' });
  await expect(page.locator('#app [data-act=commit]')).toHaveText('Enter the three dice');
  for (const d of [6, 1]) await page.click(`[data-act=key][data-id="${d}"]`);
  await expect(page.locator('#app [data-act=commit]')).toHaveText('Enter one more die');
  await page.click('[data-act=key][data-id="1"]');
  await page.click('[data-act=key][data-id="4"]');
  await expect(page.locator('#app .mat .hint')).toHaveText('That makes three dice. Delete one to change it.');
  await expect(page.locator('#app .entry .die.mini')).toHaveCount(3);
  await expect(page.locator('#app [data-act=commit]')).toHaveText('Choose the rolls used');
  await expect(page.locator('#app [data-act=rolls]')).toHaveText(['1', '2', '3']);
  await page.click('[data-act=rolls][data-id="2"]');
  await expect(page.locator('#app [data-act=commit]')).toHaveText('Save · Anna Sch 6');
  await page.click('[data-act=commit]');
  // Ben may use up to 2 rolls; a General from two rolls asks whether it came from one
  await expect(page.locator('#app [data-act=rolls]')).toHaveText(['1', '2']);
  for (const d of [5, 5, 5]) await page.click(`[data-act=key][data-id="${d}"]`);
  await page.click('[data-act=rolls][data-id="2"]');
  await expect(page.locator('#app [data-act=commit]')).toHaveText('Save · Ben Gen 5');
  await expect(page.locator('#app .mat .hint')).toHaveText('The lowest: that takes the coasters.');
  await page.click('[data-act=skhand]');
  await expect(page.locator('#app [data-act=commit]')).toHaveText('Save · Ben 555');
  await page.click('[data-act=commit]');
  await skipRace(page);
  let s = await live(page);
  expect(s.game.rounds[0].results[1]).toEqual({ dice: [5, 5, 5], hand: false, rolls: 2, pts: 1 });
  expect([s.game.players.map(p => p.score), s.game.pot, s.game.starter]).toEqual([[0, 6], 7, 1]);
  await expect(page.locator('#app [data-act=undo]')).toBeVisible();
  // round 2: Ben throws Schock out, Anna is lowest and loses the first half
  await enterThrow(page, [1, 1, 1], 1);
  await enterThrow(page, [3, 2, 2]);
  await skipRace(page);
  s = await live(page);
  expect([s.game.half, s.game.halves, s.game.pot, s.game.players.map(p => p.score)]).toEqual([2, [0], 13, [0, 0]]);
  await expect(page.locator('#app .eyebrow')).toHaveText('2nd half · Pot 13 · Sets the limit');
  // second half: a blind throw is entered with its switch; Anna loses again and with it the game
  await enterThrow(page, [3, 2, 2], 1, { blind: true });
  await enterThrow(page, [1, 1, 1]);
  await idle(page);
  s = await live(page);
  expect(s.game.rounds[2].results[0].blind).toBe(true);
  await expect(page.locator('.verdict')).toContainText('Anna loses');
  await expect(page.locator('#app .panel .sub')).toHaveText('Anna lost both halves.');
  // Schocken games aren't sent to the statistics yet
  expect(await page.evaluate(() => localStorage.getItem('sevens-out-reports'))).toBeNull();
});

test.describe('online', () => {
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' };

  test('two phones: the host picks Schocken in the lobby; a blind roll stays under the cup on both until the round ends', async ({ browser }) => {
    const A = await browser.newContext(phone), a = await A.newPage();
    await a.goto(url('/'));
    await a.click('[data-act=play]');
    await a.click('[data-act=kind][data-id="2"]');
    await a.click('[data-act=where][data-id="1"]');
    await a.fill('.sheet-layer #oname', 'Anna');
    await a.click('.sheet-layer [data-act=ocreate]');
    await expect(a.locator('.roomcode')).toHaveText(/^[A-Z2-9]{5}$/);
    const code = await a.locator('.roomcode').innerText();
    await expect(a.locator('[data-act=okind][data-id="2"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(a.locator('[data-act=opairing]')).toHaveCount(0);
    const B = await browser.newContext(phone), b = await B.newPage();
    await b.goto(url(`/?join=${code}`));
    await b.fill('.sheet-layer #oname', 'Ben');
    await b.click('.sheet-layer [data-act=ojoin]');
    await expect(b.locator('[data-act=okind][data-id="2"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(b.locator('[data-act=okind][data-id="2"]')).toBeDisabled();
    expect(await noSideScroll(b)).toBe(true);
    await a.click('[data-act=ostart]');
    await expect(a.locator('[data-act=roll]')).toBeVisible();
    await expect(b.locator('#app .bar .waiting')).toContainText('Waiting for Anna to roll');
    await a.click('[data-act=blind]'); await a.click('[data-act=blind]');
    await expect(b.locator('[data-act=roll]')).toBeVisible();
    await expect(b.locator('#app .mat-foot .hint')).toHaveText('Anna rolled blind: the cup stays down until the round ends.');
    await expect(b.locator('#app .tobeat')).toHaveText('Under the cup: 1 blind');
    const sb = await live(b);
    expect(sb.game.rounds[0].results[0]).toEqual({ dice: null, kept: [], hand: true, rolls: 1, blind: true });
    expect(sb.game.turn.maxRolls).toBe(1); // a blind first roll: one roll for everyone
    await b.click('[data-act=roll]');
    await b.click('[data-act=end]');
    await expect.poll(async () => (await live(a)).game.round).toBe(2);
    const sa = await live(a), sb2 = await live(b);
    expect(sa.game.rounds[0].results[0].dice).toHaveLength(3);
    expect(sb2.game.rounds).toEqual(sa.game.rounds);
    expect(sa.game.starter).toBe(sa.game.rounds[0].loser);
    await A.close(); await B.close();
  });
});
