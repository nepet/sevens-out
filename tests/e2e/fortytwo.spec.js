// 42/18 in the browser: the game choice, the dice turn with kept dice, real dice, the round's coaster and game over,
// and two phones online. Runs against the Node server (npm run test:e2e), the online test also with TARGET=worker.
import { test, expect } from '@playwright/test';
import '../../engine.js';
import { checkReport } from '../../server/core/stats.js';
import { url, live, idle, skipRace, fixDice, noSideScroll, openMenu, closeMenu, openScores, closeScores } from './helpers.js';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

// home → Play sheet (42/18, at this table, the dice) → Who's playing → Start
async function start42(page, { names = ['Anna', 'Ben'], mode = 'dice' } = {}) {
  await page.goto(url('/'));
  await page.click('[data-act=play]');
  await page.click('[data-act=kind][data-id="1"]');
  await expect(page.locator('[data-act=kind][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
  if (await page.locator('[data-act=where][data-id="0"]').count()) await page.click('[data-act=where][data-id="0"]');
  await page.click(`[data-act=mode][data-id="${mode === 'score' ? 1 : 0}"]`);
  await expect(page.locator('.sheet-layer [data-act=pairing]')).toHaveCount(0); // no 7s in 42/18
  await page.click('[data-act=players]');
  await expect(page.locator('.moderow')).toContainText(`42/18 · ${mode === 'score' ? 'Real dice' : 'Dice in the app'}`);
  for (let i = 2; i < names.length; i++) await page.click('[data-act=add]');
  for (let i = 0; i < names.length; i++) await page.fill(`#name-${i}`, names[i]);
  await page.click('[data-act=start]');
}
// one real-dice turn: the points (0 = No 42) and the rolls used
async function enterThrow(page, pts, rolls = 1) {
  await closeScores(page);
  await page.click('[data-act=clear]');
  if (pts === 0) await page.click('[data-act=no42]');
  else for (const ch of String(pts)) await page.click(`[data-act=key][data-id="${ch}"]`);
  await page.click(`[data-act=rolls][data-id="${rolls}"]`);
  await page.click('[data-act=commit]');
}
const mat = page => page.locator('#app .mat .dice');
const tray = page => page.locator('#app .tray');

test('the dice turn: keep at least one, put one back, 42/18 puts Anna out, and the lowest throw takes a coaster', async ({ page, context }) => {
  // Anna: 4 1 3 5 6, keeps the 4 and the 6, then 2 6 6: 42/18. Ben: 1 1 1 1 1, keeps one, then 3 3 3 3: no 42.
  // Cleo: 4 2 5 5 5: 42 + 15
  await fixDice(context, [4, 1, 3, 5, 6, 2, 6, 6, 1, 1, 1, 1, 1, 3, 3, 3, 3, 4, 2, 5, 5, 5]);
  await start42(page, { names: ['Anna', 'Ben', 'Cleo'] });
  let s = await live(page);
  expect(s.game.kind).toBe('4218');
  await expect(page.locator('#app .tobeat')).toHaveText('First throw of the round: nothing to beat yet.');
  await expect(page.locator('#app .throwcell')).toContainText('–');
  await page.click('[data-act=roll]');
  await expect(mat(page).locator('.die')).toHaveCount(5);
  await expect(page.locator('#app .throwcell b')).toHaveText('no 42');
  // a roll before keeping a die is refused, with a hint
  await expect(page.locator('#app .rollbtn small')).toHaveText('keep one');
  await page.click('[data-act=roll]');
  await expect(page.locator('#app .mat-foot .hint')).toHaveText('Keep at least one die first: tap it.');
  expect((await live(page)).game.turn.rolls).toBe(1);
  await mat(page).locator('[aria-label="Die showing 4"]').click();
  await mat(page).locator('[aria-label="Die showing 6"]').click();
  await mat(page).locator('[aria-label="Die showing 1"]').click();
  await expect(tray(page).locator('button.die')).toHaveCount(3);
  await expect(mat(page).locator('.die')).toHaveCount(2);
  await tray(page).locator('[aria-label="Put the 1 back on the table"]').click();
  await expect(tray(page).locator('.die')).toHaveCount(2);
  await expect(page.locator('#app .rollbtn small')).toHaveText('3 dice');
  await page.click('[data-act=roll]');
  // 42/18: out at once, so the roll ends the turn. The throw lies on the mat for a moment (no Stop, no Roll, no keeping)
  await expect(page.locator('#app .throwcell b')).toHaveText('42+18');
  await expect(page.locator('#app .eyebrow')).toHaveText('Round 1 · Roll 2 of 5');
  await expect(page.locator('#app .mat-foot .hint')).toHaveText('42/18! Out and safe for the rest of the game.');
  await expect(page.locator('#app .bar .handoff')).toHaveText('Next upBen');
  await expect(page.locator('#app :is([data-act=stop], [data-act=roll], [data-act=end])')).toHaveCount(0);
  await expect(page.locator('#app button.die')).toHaveCount(0);
  await expect(page.locator('.fx-banner')).toContainText('42/18!');
  await expect(page.locator('.fx-banner')).toContainText('Anna is out: safe for the rest of the game');
  await expect(page.locator('#app .who')).toContainText('Ben');
  await expect(page.locator('#app .tobeat')).toHaveText('To beat: Anna · 42 + 18 in 2 rolls');
  await page.click('[data-act=roll]');
  await expect(page.locator('#app .throwcell')).toHaveClass(/\blow\b/);
  await expect(page.locator('#app .throwcell .racklabel')).toHaveText('lowest now');
  await mat(page).locator('.die').first().click();
  await page.click('[data-act=roll]');
  await page.click('[data-act=stop]'); await page.click('[data-act=stop]');
  await expect(page.locator('#app .who')).toContainText('Cleo');
  await page.click('[data-act=roll]');
  await expect(page.locator('#app .throwcell .racklabel')).toHaveText('beats it');
  await page.click('[data-act=stop]'); await page.click('[data-act=stop]');
  await skipRace(page);
  s = await live(page);
  expect(s.game.rounds[0].results).toEqual({ 0: { pts: 18, rolls: 2 }, 1: { pts: 0, rolls: 2 }, 2: { pts: 15, rolls: 1 } });
  expect(s.game.players.map(p => p.score)).toEqual([0, 1, 0]);
  expect(s.game.players[0].out).toBe(1);
  expect(s.game.starter).toBe(1); // the loser starts the next round
  expect(s.game.order).toEqual([1, 2]); // without Anna
  await expect(page.locator('#app .who')).toContainText('Ben');
  await expect(page.locator('#app .scorechip')).toHaveAttribute('aria-label', 'Coasters: Ben 1, Cleo 0');
  await openScores(page);
  await expect(page.locator('#app .scores-pop .bhead')).toContainText('3 coasters lose');
  await expect(page.locator('#app .scores-pop .pl').last()).toHaveAttribute('data-id', '0');
  await expect(page.locator('#app .scores-pop .pl[data-id="0"] .dl')).toHaveText('out');
  await closeScores(page);
  await openMenu(page, 'sheet');
  await expect(page.locator('.sheet-layer table td.lc')).toHaveText('no 422×');
  await expect(page.locator('.sheet-layer details[data-fold=rules] summary')).toHaveText('How to play 42/18');
  await closeMenu(page);
  expect(await noSideScroll(page)).toBe(true);
});

test('the dice turn fits a small phone: the dice, the kept tray and the bar', async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await fixDice(context, [4, 2, 5, 1, 3]);
  await start42(page, { names: ['Anna', 'Ben', 'Cleo', 'Dan', 'Eve', 'Finn'] });
  await page.click('[data-act=roll]');
  for (const v of [4, 2]) await mat(page).locator(`[aria-label="Die showing ${v}"]`).click();
  const inView = sel => page.locator(sel).evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; });
  for (const sel of ['#app [data-act=stop]', '#app [data-act=roll]', '#app .throwcell', '#app .tray', '#app .tobeat']) expect(await inView(sel), sel).toBe(true);
  // the dice on the table stay above the tray
  const trayTop = await tray(page).evaluate(el => el.getBoundingClientRect().top);
  const bottoms = await mat(page).locator('.die').evaluateAll(ds => ds.map(d => d.getBoundingClientRect().bottom));
  expect(bottoms).toHaveLength(3);
  for (const b of bottoms) expect(b).toBeLessThanOrEqual(trayTop);
  expect(await noSideScroll(page)).toBe(true);
});

test('real dice: throws, No 42, a correction, and game over at three coasters', async ({ page }) => {
  const reports = [];
  await page.route('**/report', async route => { reports.push(route.request().postDataJSON()); await route.fulfill({ status: 204 }); });
  await start42(page, { mode: 'score' });
  await expect(page.locator('#app [data-act=commit]')).toHaveText('Enter the points');
  await page.click('[data-act=key][data-id="2"]');
  await expect(page.locator('#app [data-act=commit]')).toHaveText('Points are 3 to 18');
  await page.click('[data-act=key][data-id="0"]');
  await expect(page.locator('#app .mat .hint')).toHaveText('The most is 18: three 6s.');
  await page.click('[data-act=clear]');
  await page.click('[data-act=key][data-id="1"]'); await page.click('[data-act=key][data-id="5"]');
  await expect(page.locator('#app [data-act=commit]')).toHaveText('Choose the rolls used');
  await expect(page.locator('#app [data-act=rolls]')).toHaveText(['1', '2', '3', '4', '5']);
  for (const box of await page.locator('#app [data-act=rolls]').evaluateAll(bs => bs.map(b => b.getBoundingClientRect().width))) expect(box).toBeGreaterThanOrEqual(44);
  await page.click('[data-act=rolls][data-id="2"]');
  await expect(page.locator('#app [data-act=commit]')).toHaveText('Save · Anna 42+15');
  await page.click('[data-act=commit]');
  await expect(page.locator('#app .tobeat')).toHaveText('To beat: Anna · 42 + 15 in 2 rolls');
  for (const k of ['1', '5']) await page.click(`[data-act=key][data-id="${k}"]`);
  await expect(page.locator('#app .mat .hint')).toHaveText('Tied with Anna: fewer rolls beat it.');
  await page.click('[data-act=rolls][data-id="1"]');
  await expect(page.locator('#app .mat .hint')).toHaveText('Beats Anna.');
  await page.click('[data-act=rolls][data-id="2"]');
  await expect(page.locator('#app .mat .hint')).toHaveText('The lowest: that takes the coaster.');
  await enterThrow(page, 0);                 // Ben: no 42, takes a coaster and starts round 2
  await skipRace(page);
  let s = await live(page);
  expect(s.game.players.map(p => p.score)).toEqual([0, 1]);
  expect(s.game.starter).toBe(1);
  // round 2 (Ben, Anna): Anna lower
  await enterThrow(page, 9, 1); await enterThrow(page, 4, 3);
  await skipRace(page);
  // a correction: Anna's 4 was really a 12, so Ben lost round 2 too, and Ben starts round 3
  await openScores(page);
  await page.click('#app .board .pl[data-act=edit][data-id="0"]');
  await page.fill('#edit-2', '12');
  await page.click('[data-act=esave]');
  s = await live(page);
  expect(s.game.players.map(p => p.score)).toEqual([0, 2]);
  expect(s.game.starter).toBe(1);
  await expect(page.locator('#app .who')).toContainText('Ben');
  // round 3: Ben takes the third coaster
  await enterThrow(page, 3, 2); await enterThrow(page, 3, 1);
  await idle(page);
  await expect(page.locator('.verdict')).toContainText('Ben loses');
  await expect(page.locator('#app .panel .sub')).toHaveText('Ben took coaster number 3 with 42 + 3, the lowest throw of round 3.');
  await expect(page.locator('#app .lede')).toHaveText('Anna wins with 0 coasters.');
  // the finished game goes to the statistics as 42/18, and the server's check rebuilds the same result
  await expect.poll(() => reports.length).toBe(1);
  expect(reports[0].kind).toBe('4218');
  const r = checkReport(reports[0], globalThis.SevensEngine);
  expect(r.error).toBeUndefined();
  expect(r.state.game.loser).toBe((await live(page)).game.loser);
});

test('real dice: a 42/18 puts the player out, it can only be undone, and the last player left loses', async ({ page }) => {
  await start42(page, { names: ['Anna', 'Ben', 'Cleo'], mode: 'score' });
  for (const k of ['1', '8']) await page.click(`[data-act=key][data-id="${k}"]`);
  await expect(page.locator('#app .mat .hint')).toHaveText('42/18, three 6s: out and safe for the rest of the game.');
  await page.click('[data-act=rolls][data-id="3"]');
  await page.click('[data-act=commit]');
  await enterThrow(page, 5); await enterThrow(page, 7); // Ben lowest
  await skipRace(page);
  let s = await live(page);
  expect(s.game.order).toEqual([1, 2]);
  // Anna's 42/18 can't be corrected: the row is fixed, without steppers
  await openScores(page);
  await page.click('#app .board .pl[data-act=edit][data-id="0"]');
  await expect(page.locator('#app .erow .efixed')).toHaveText('42 + 18');
  await expect(page.locator('#app #edit-1')).toHaveCount(0);
  await page.click('[data-act=ecancel]');
  // Ben corrects his 5 up: the steppers stop at 17
  await openScores(page);
  await page.click('#app .board .pl[data-act=edit][data-id="1"]');
  await page.fill('#edit-1', '17');
  await page.click('#app [data-act=estep][data-id="1"][data-d="1"]');
  await expect(page.locator('#edit-1')).toHaveValue('17');
  await page.click('[data-act=ecancel]');
  // round 2: Ben 10, then Cleo 42/18: Ben is the only one left and loses at once
  await enterThrow(page, 10); await enterThrow(page, 18);
  await idle(page);
  await expect(page.locator('.verdict')).toContainText('Ben loses');
  await expect(page.locator('#app .panel .sub')).toHaveText('Ben is the last one left: all the others threw 42/18.');
  await expect(page.locator('#app .board .pl[data-id="0"] .dl')).toHaveText('out');
  // Undo brings Cleo back in
  await page.click('#app [data-act=undo]');
  s = await live(page);
  expect(s.phase).toBe('play');
  expect(s.game.players[2].out).toBeUndefined();
});

test.describe('online', () => {
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' };

  test('two phones: the host picks 42/18 in the lobby, and keeping dice shows on both', async ({ browser }) => {
    const A = await browser.newContext(phone), a = await A.newPage();
    await a.goto(url('/'));
    await a.click('[data-act=play]');
    await a.click('[data-act=kind][data-id="1"]');
    await a.click('[data-act=where][data-id="1"]');
    await a.fill('.sheet-layer #oname', 'Anna');
    await a.click('.sheet-layer [data-act=ocreate]');
    await expect(a.locator('.roomcode')).toHaveText(/^[A-Z2-9]{5}$/);
    const code = await a.locator('.roomcode').innerText();
    // the game chosen in the Play sheet follows into the new room
    await expect(a.locator('[data-act=okind][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(a.locator('[data-act=opairing]')).toHaveCount(0);
    const B = await browser.newContext(phone), b = await B.newPage();
    await b.goto(url(`/?join=${code}`));
    await b.fill('.sheet-layer #oname', 'Ben');
    await b.click('.sheet-layer [data-act=ojoin]');
    await expect(b.locator('[data-act=okind][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(b.locator('[data-act=okind][data-id="1"]')).toBeDisabled();
    // the host switches back and forth; the guest follows
    await a.click('[data-act=okind][data-id="0"]');
    await expect(b.locator('[data-act=okind][data-id="0"]')).toHaveAttribute('aria-pressed', 'true');
    await a.click('[data-act=okind][data-id="1"]');
    await expect(b.locator('[data-act=okind][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
    await a.click('[data-act=ostart]');
    await expect(a.locator('[data-act=roll]')).toBeVisible();
    await expect(b.locator('#app .bar .waiting')).toContainText('Waiting for Anna to roll');
    await a.click('[data-act=roll]');
    await expect(b.locator('#app .mat .dice .die')).toHaveCount(5);
    await a.locator('#app .mat .dice button.die').first().click();
    await expect(b.locator('#app .tray .die')).toHaveCount(1);
    await expect(b.locator('#app .tray button.die')).toHaveCount(0); // watchers can't put it back
    await a.click('[data-act=stop]'); await a.click('[data-act=stop]');
    await expect(b.locator('[data-act=roll]')).toBeVisible();
    await expect.poll(async () => (await live(a)).game.pos).toBe(1);
    const sa = await live(a), sb = await live(b);
    expect(sa.game.kind).toBe('4218');
    expect(sb.game.rounds).toEqual(sa.game.rounds);
    expect(sb.game.rounds[0].results[0].rolls).toBe(1);
    await A.close(); await B.close();
  });
});
