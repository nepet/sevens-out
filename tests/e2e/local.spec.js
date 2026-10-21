// Pass-and-play on one phone: both modes, the animations, corrections, the shots alarm and shake to roll.
import { test, expect } from '@playwright/test';
import '../../engine.js';
import { legacyRoundEnd, must } from '../games.js';
import { checkReport } from '../../server/core/stats.js';
import { saved, live, idle, skipRace, fixDice, startLocal, enterScore, checkSheet, noSideScroll, openMenu, closeMenu, openSettings, toPlayers, openScores, closeScores, editLine, stopPts } from './helpers.js';

test.describe('dice mode', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('a full game follows every rule', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo'], starter: 1 });
    let seed = 7;
    const coin = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % 10 < 6; };
    for (let step = 0; step < 4000; step++) {
      const s = await saved(page);
      if (s.phase === 'over') break;
      const t = s.game.turn, canRoll = t.rolls < t.maxRolls && t.dice.some(d => d.held === null);
      if (t.rolls === 0 || (canRoll && coin())) await page.click('[data-act=roll]');
      else if (canRoll) { await page.click('[data-act=stop]'); await page.click('[data-act=stop]'); await skipRace(page); }
      else { await page.click('[data-act=end]'); await skipRace(page); }
    }
    const s = await saved(page);
    expect(s.phase).toBe('over');
    expect(s.game.rounds[0].starter).toBe(1);
    checkSheet(s.game);
    await expect(page.locator('.verdict')).toContainText('loses');
    expect(errors).toEqual([]);
  });

  test('a pair from this roll can be put back, and two dice can be paired by hand', async ({ page, context }) => {
    await fixDice(context, [1, 6, 2, 2, 3, 3]);
    await startLocal(page, { pairing: 'auto' });
    await page.click('[data-act=roll]');
    await expect(page.locator('.rack .pair')).toHaveCount(1);
    await page.click('[data-act=unpair][data-id="0"]');
    await expect(page.locator('.rack .pair')).toHaveCount(0);
    await expect(page.locator('.hint')).toContainText('back on the table');
    await page.click('.dice [data-act=die][data-id="2"]');
    await expect(page.locator('.hint')).toContainText('There is no 5 on the table to go with this 2');
    await page.click('.dice [data-act=die][data-id="0"]');
    await page.click('.dice [data-act=die][data-id="1"]');
    await expect(page.locator('.rack .pair')).toHaveCount(1);
    await expect(stopPts(page)).toHaveText('+10');
  });

  test('by default the player finds the 7s: no help on screen, and a missed pair counts', async ({ page, context }) => {
    await fixDice(context, [1, 6, 2, 5, 3, 3]);
    await startLocal(page);
    await page.click('[data-act=roll]');
    await expect(page.locator('.dice button.die')).toHaveCount(6);
    await expect(page.locator('.rack .pair')).toHaveCount(0);
    await expect(page.locator('.die.can')).toHaveCount(0);           // pairs aren't highlighted
    await expect(page.locator('[data-act=takeall]')).toHaveCount(0);
    await expect(stopPts(page)).toHaveText('+20');                    // everything on the table counts
    await expect(page.locator('.hint')).toContainText('Find the 7s');
    await page.click('.dice [data-act=die][data-id="4"]');             // a 3 can be picked even with no 4 around
    await expect(page.locator('.hint')).toContainText('Now tap a 4');
    await page.click('.dice [data-act=die][data-id="5"]');
    await expect(page.locator('.hint')).toContainText('3 + 3 makes 6, not 7');
    await page.click('.dice [data-act=die][data-id="4"]');             // put the 3 down again
    await page.click('.dice [data-act=die][data-id="1"]');
    await page.click('.dice [data-act=die][data-id="0"]');
    await expect(page.locator('.rack .pair')).toHaveCount(1);
    await expect(stopPts(page)).toHaveText('+13');
    await page.click('[data-act=stop]'); await page.click('[data-act=stop]');
    expect((await saved(page)).game.players[0].score).toBe(13);       // the 2 and 5 were missed
  });

  test('a missed 7-pair gets the "Need glasses?" joke, rolled away or left on the table', async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await fixDice(context, [1, 6, 2, 5, 3, 3, 4, 3, 1, 1]);
    await startLocal(page);
    await page.click('[data-act=roll]');
    await page.click('.dice [data-act=die][data-id="0"]'); await page.click('.dice [data-act=die][data-id="1"]'); // the 1 + 6 is found
    await expect(page.locator('.miss')).toHaveCount(0);
    await page.click('[data-act=roll]');                                // the 2 + 5 is not
    await expect(page.locator('.miss')).toContainText('Need glasses?');
    await expect(page.locator('.miss-sub')).toHaveText('Anna rolled away 2 + 5.');
    expect(await page.locator('.miss-die').evaluateAll(ds => ds.map(d => d.querySelectorAll('.pip').length))).toEqual([2, 5]);
    // taps go through the joke to the game, and a new one replaces it
    await page.click('[data-act=stop]'); await page.click('[data-act=stop]');
    await expect(page.locator('.miss')).toHaveCount(1);
    await expect(page.locator('.miss-sub')).toHaveText("Anna left 4 + 3 on the table. That's 7 extra points.");
    expect((await saved(page)).game.players[0].score).toBe(4 + 3 + 1 + 1);
    await page.click('[data-act=roll]');                                // Ben's roll clears it
    await expect(page.locator('.miss')).toHaveCount(0);
    await openMenu(page, 'dev');
    await page.click('[data-act=devmiss]');                             // the developer menu can play it too
    await expect(page.locator('.miss-sub')).toContainText('Ben left 2 + 5 on the table');
    await expect(page.locator('.miss')).toHaveCount(0, { timeout: 5000 }); // and it goes by itself
    expect(errors).toEqual([]);
  });
});

test('after a roll the dice lie still, then the 7-pairs fly out one by one and Sevens Out celebrates', async ({ page, context }) => {
  await fixDice(context, [1, 6, 2, 5, 3, 4]);
  await startLocal(page, { pairing: 'auto' });
  await page.click('[data-act=roll]');
  await page.waitForTimeout(900); // landed, still lying there
  await expect(page.locator('.rack .pair')).toHaveCount(0);
  await expect(page.locator('.dice .die:not(.gone)')).toHaveCount(6);
  await expect(page.locator('[data-act=roll]')).toHaveCount(0); // locked while pairs fly
  await expect(page.locator('.rack .pair')).toHaveCount(3, { timeout: 5000 });
  await expect(page.locator('.fx-banner')).toContainText('Anna cleared all six dice');
  await idle(page);
  await expect(page.locator('.die.fly')).toHaveCount(0);
  await expect(page.locator('[data-act=end]')).toContainText('+0');
});

test.describe('scoreboard mode', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('a full game with three players follows every rule, and undo works from game over', async ({ page }) => {
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo'], mode: 'score' });
    // 37 is refused and the starter must pick the rolls used
    await page.click('[data-act=key][data-id="3"]');
    await page.click('[data-act=key][data-id="7"]');
    await expect(page.locator('.entry')).toHaveText('3');
    await expect(page.locator('[data-act=commit]')).toBeDisabled();
    let seed = 11;
    const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let step = 0; step < 400; step++) {
      const s = await saved(page);
      if (s.phase === 'over') break;
      await enterScore(page, rnd(25), s.game.pos === 0 ? 1 + rnd(3) : 0);
      await skipRace(page);
    }
    const s = await saved(page);
    expect(s.phase).toBe('over');
    checkSheet(s.game);
    await page.click('[data-act=undo]');
    expect((await saved(page)).phase).toBe('play');
  });

  test('tie for the lead: whoever reached the score first starts', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 20); await skipRace(page);
    await enterScore(page, 0, 2); await enterScore(page, 10);       // Ben stays on 20, Anna climbs to 20
    await expect(page.locator('.race-why')).toHaveText('Tied on 20, got there first');
    await skipRace(page);
    const s = await saved(page);
    expect([s.phase, s.game.round, s.game.starter]).toEqual(['play', 3, 1]); // Ben got there first
  });

  test('corrections recompute totals, the starter and the 101 rule; undo takes them back', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 20); await skipRace(page);
    await editLine(page, 1);
    await page.fill('#edit-1', '40');
    await expect(page.locator('[data-act=esave]')).toBeDisabled();
    await page.fill('#edit-1', '5');
    await expect(page.locator('#edit-total')).toHaveText('5');
    await page.click('[data-act=esave]');
    let s = await saved(page);
    expect(s.game.players.map(p => p.score)).toEqual([10, 5]);
    expect([s.game.round, s.game.starter]).toEqual([2, 0]);          // round 2 starts again, now with Anna
    await enterScore(page, 36, 3); await enterScore(page, 0); await skipRace(page);
    await editLine(page, 0);
    await page.fill('#edit-1', '36');
    await page.click('[data-act=esave]');
    expect((await saved(page)).game.players.map(p => p.score)).toEqual([72, 5]);
    await enterScore(page, 30, 1); await enterScore(page, 0);
    expect((await saved(page)).phase).toBe('over');
    await editLine(page, 0);
    await page.fill('#edit-3', '10');
    await page.click('[data-act=esave]');
    s = await saved(page);
    expect([s.phase, s.game.round]).toEqual(['play', 4]);           // below 101 again: the next round starts
    await page.click('[data-act=undo]');
    expect((await saved(page)).phase).toBe('over');
  });

  test('the third dropped die sets off the round-of-shots alarm', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await page.click('[data-act=drop]');
    await page.click('[data-act=drop]');
    await expect(page.locator('.fslot.on')).toHaveCount(2);
    await page.click('[data-act=drop]');
    await expect(page.locator('.doom')).toBeVisible();
    await expect(page.locator('.doom-sub')).toContainText('Anna dropped the third die');
    await page.click('.doom-ok');
    await expect(page.locator('.doom')).toHaveCount(0);
    await openScores(page);
    await expect(page.locator('.pl-shots')).toContainText('Paid 1 round of shots');
    await closeScores(page);                                           // a tap on the mat would only close the list
    await page.click('[data-act=undo]');
    const s = await saved(page);
    expect(s.game.drops).toBe(2);
    expect(s.game.shots.length).toBe(0);
  });
});

test.describe('on a phone', () => {
  test.use({ isMobile: true, hasTouch: true });

  test('shake to roll: one bump does nothing, a shake rolls', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await page.click('.sheet-layer [data-act=shake][data-id="1"]');
    await startLocal(page);
    await expect(page.locator('.hint')).toContainText('shake the phone');
    const jolt = x => page.evaluate(v => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: v, y: 0, z: 0 } })), x);
    await jolt(25);
    await page.waitForTimeout(1000);
    expect((await saved(page)).game.turn.rolls).toBe(0);
    for (let k = 0; k < 4; k++) { await jolt(k % 2 ? -22 : 22); await page.waitForTimeout(110); }
    await expect.poll(async () => (await saved(page)).game.turn.rolls).toBe(1);
  });

  test('a refused motion permission says so in the Settings sheet and in the game menu', async ({ page }) => {
    await page.addInitScript(() => { DeviceMotionEvent.requestPermission = () => Promise.resolve('denied'); });
    await page.goto('/');
    await openSettings(page);
    await page.click('.sheet-layer [data-act=shake][data-id="1"]');
    await expect(page.locator('.sheet-layer .shake-hint')).toContainText("didn't allow motion access");
    await expect(page.locator('#app .home-hint')).toHaveText(''); // only the sheet says it
    await startLocal(page);
    await openMenu(page);
    await page.click('.sheet-layer [data-act=shake][data-id="1"]');
    await expect(page.locator('.sheet-layer .shake-hint')).toContainText("didn't allow motion access");
  });

  test('shaking during the race between rounds does not roll', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await openSettings(page);
    await page.click('.sheet-layer [data-act=shake][data-id="1"]');
    await startLocal(page);
    await page.click('[data-act=roll]'); await page.click('[data-act=stop]'); await page.click('[data-act=stop]');
    await idle(page);
    await page.click('[data-act=roll]'); await page.click('[data-act=end]');  // Ben has Anna's one roll
    await expect(page.locator('.race')).toBeVisible();
    const jolt = x => page.evaluate(v => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: v, y: 0, z: 0 } })), x);
    for (let k = 0; k < 4; k++) { await jolt(k % 2 ? -22 : 22); await page.waitForTimeout(110); }
    await expect(page.locator('.race')).toHaveCount(0);
    await idle(page);
    const s = await saved(page);
    expect([s.game.round, s.game.turn.rolls]).toEqual([2, 0]);
  });
});

// scoreboard mode, Anna starts every round with 36 and reaches 108 in round 3; Ben adds 5 a round
async function playShortGame(page) {
  await startLocal(page, { names: ['Anna', 'Ben'], mode: 'score' });
  for (let round = 1; round <= 3; round++) {
    await enterScore(page, 36, 1);
    await enterScore(page, 5);
    if (round < 3) await skipRace(page);
  }
  await expect(page.locator('.verdict')).toContainText('loses');
}

test.describe('the score list', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const names = page => page.locator('.board .pl .nm').allTextContents();

  test('the score list follows the round\'s playing order', async ({ page }) => {
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo'], starter: 1 });
    await openScores(page);
    expect(await names(page)).toEqual(['Ben', 'Cleo', 'Anna']);
    await expect(page.locator('.board .bhead')).toContainText('Round 1 · Ben starts');
    await expect(page.locator('.board .bhead')).toContainText('to 101');
    const line = i => page.locator(`.board .pl[data-id="${i}"]`);
    await expect(line(1)).toHaveClass(/\bnow\b/);
    await expect(line(1).locator('.nm i.sd')).toHaveCount(1);
    await expect(page.locator('.board i.sd')).toHaveCount(1);
    await expect(line(1).locator('.dl')).toHaveText('now');
    for (const i of [2, 0]) {
      await expect(line(i)).toHaveClass(/\bwait\b/);
      await expect(line(i)).not.toHaveClass(/\bnow\b/);
      await expect(line(i).locator('.dl')).toHaveText('–');
    }
    await expect(page.locator('.board .bfoot')).toHaveCount(0); // corrections are for real-dice games
    await expect(page.locator('.board ol.lines')).not.toHaveAttribute('role', /.*/); // a plain list of list items
    await page.click('[data-act=roll]');                               // the bar acts with the list open
    await page.click('[data-act=stop]'); await page.click('[data-act=stop]');
    await openScores(page);                                            // still open
    await expect(line(1).locator('.dl')).toHaveText(/^\+\d+$/);
    await expect(line(1)).not.toHaveClass(/\bnow\b|\bwait\b/);
    await expect(line(2)).toHaveClass(/\bnow\b/);
    await expect(line(2).locator('.dl')).toHaveText('now');
    const score = (await saved(page)).game.players[1].score;
    await expect(line(1).locator('.num')).toHaveText(String(score));
    await expect(line(1).locator('.dl')).toHaveText(`+${score}`);
  });

  test('six players fit on one screen', async ({ page }) => {
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo', 'Dan', 'Eve', 'Maximilian Long'], mode: 'score' });
    for (const lookId of ['0', '1']) {
      await openMenu(page); await page.click(`[data-act=look][data-id="${lookId}"]`); await closeMenu(page);
      await openScores(page);                                     // the full list opens from the chip
      await expect(page.locator('.board .pl')).toHaveCount(6);
      const box = await page.locator('.board').boundingBox();
      expect(box.height).toBeLessThanOrEqual(340);   // real dice: tappable 44 px rows (the dice turn's dense list is about 260)
      expect(await noSideScroll(page)).toBe(true);
      // a name longer than its column is cut, not wrapped
      const nm = page.locator('.board .pl[data-id="5"] .nm');
      const one = await page.locator('.board .pl[data-id="0"] .nm').boundingBox();
      expect((await nm.boundingBox()).height).toBeLessThanOrEqual(one.height + 1);
    }
    await expect(page.locator('.board .bfoot')).toHaveText('Tap a name to correct a score');
    await expect(page.locator('.board .pl.editable[role=button][tabindex="0"][data-act=edit]')).toHaveCount(6);
    await expect(page.locator('.board .pl[data-id="1"]')).toHaveAttribute('aria-label', "Correct Ben's scores");
    await expect(page.locator('.board ol.lines')).toHaveAttribute('role', 'none'); // its items are buttons, not list items
  });

  test('game over lists the scores from the top with the loser marked', async ({ page }) => {
    await playShortGame(page);
    expect(await names(page)).toEqual(['Anna', 'Ben']);
    const anna = page.locator('.board .pl[data-id="0"]'), ben = page.locator('.board .pl[data-id="1"]');
    await expect(anna).toHaveClass(/\blost\b/);
    await expect(anna).toHaveClass(/\bover\b/);
    await expect(anna.locator('.dl')).toHaveText('Loses');
    await expect(anna.locator('.num')).toHaveText('108');
    await expect(ben).not.toHaveClass(/\blost\b|\bover\b|\bnow\b|\bwait\b/);
    await expect(ben.locator('.dl')).toHaveText('+5');
    await expect(page.locator('.board .bhead')).toContainText('Final scores');

    // the highest total goes on top, whatever the seating or playing order
    await page.evaluate(() => localStorage.removeItem('sevens-out-v1'));
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo'], mode: 'score' });
    for (const [pts, rolls] of [[36, 1], [0], [30], [0, 1], [0], [36], [0, 1], [36], [0], [0, 1], [0], [36]]) { await enterScore(page, pts, rolls); await skipRace(page); }
    await expect(page.locator('.verdict')).toContainText('Cleo loses');
    expect((await saved(page)).game.order).toEqual([0, 1, 2]);
    expect(await names(page)).toEqual(['Cleo', 'Anna', 'Ben']);   // 102, 72, 0
    await expect(page.locator('.board .pl').first()).toHaveClass(/\blost\b/);
  });
});

test.describe('between rounds', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const names = (page, sel = '.board') => page.locator(`${sel} .pl .nm`).allTextContents();

  test('between rounds the race shows the round and hands over to the next starter', async ({ page }) => {
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo'], mode: 'score' });
    await enterScore(page, 12, 2); await enterScore(page, 0); await enterScore(page, 26);
    const race = page.locator('.race');
    await expect(race).toBeVisible();
    await expect(race.locator('.race-badge')).toContainText('Sevens Out');
    await expect(race.locator('.race-badge')).toContainText('Ben cleared all six');
    // reduced motion: the grown list shows the final totals in their final order at once
    await expect(race.locator('.race-card .bhead')).toContainText('After round 1');
    expect(await names(page, '.race-card')).toEqual(['Cleo', 'Anna', 'Ben']);
    expect(await race.locator('.race-card .pl .num').allTextContents()).toEqual(['26', '12', '0']);
    await expect(race.locator('.race-curtain .race-round')).toHaveText('Round 2');
    await expect(race.locator('.race-curtain .race-starter')).toHaveText('Cleo starts');
    await expect(race.locator('.race-curtain .race-why')).toHaveText('Highest score: 26');
    await expect(race).toHaveCount(0);
    await idle(page);
    await openScores(page);
    expect(await names(page)).toEqual(['Cleo', 'Anna', 'Ben']);
    await expect(page.locator('.board .bhead')).toContainText('Round 2 · Cleo starts');
  });

  test('a tap skips the race', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 20);
    await page.locator('.race').click();
    await expect(page.locator('.race')).toHaveCount(0, { timeout: 1000 });
    const s = await live(page);
    expect([s.game.round, s.game.starter]).toEqual([2, 1]);
    await openScores(page);
    await expect(page.locator('.board .bhead')).toContainText('Round 2 · Ben starts');
    await idle(page);
  });

  test('Escape skips the race too, and a reload during it keeps the last turn', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 20);
    await expect(page.locator('.race')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.race')).toHaveCount(0);
    await openScores(page);
    await expect(page.locator('.board .bhead')).toContainText('Round 2 · Ben starts');
    await enterScore(page, 5, 1); await enterScore(page, 30);       // Anna 40, Ben 25: Anna starts round 3
    await expect(page.locator('.race')).toBeVisible();
    await page.reload();
    await openScores(page);
    await expect(page.locator('.board .bhead')).toContainText('Round 3 · Anna starts');
    await expect(page.locator('.race')).toHaveCount(0);
    expect((await saved(page)).game.players.map(p => p.score)).toEqual([40, 25]);
  });

  test('no race when the game ends', async ({ page }) => {
    await playShortGame(page);
    await expect(page.locator('.verdict')).toBeVisible();
    await expect(page.locator('.race')).toHaveCount(0);
  });

  test('a correction right after a round restarts it with the right starter, without a race', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 20);
    await skipRace(page);
    await editLine(page, 1);
    await page.fill('#edit-1', '5');
    await page.click('[data-act=esave]');
    await expect(page.locator('.race')).toHaveCount(0);
    await idle(page);
    await openScores(page);
    expect((await names(page))[0]).toBe('Anna');
    await expect(page.locator('.board .bhead')).toContainText('Round 2 · Anna starts');
  });

  test('undo right after a round goes back into it, and the race plays again', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 20);
    await skipRace(page);
    await page.click('[data-act=undo]');
    const s = await live(page);
    expect([s.game.round, s.game.order[s.game.pos]]).toEqual([1, 1]);   // Ben to play
    await expect(page.locator('.race')).toHaveCount(0);
    await enterScore(page, 20);
    await expect(page.locator('.race')).toBeVisible();
    await expect(page.locator('.race-starter')).toHaveText('Ben starts');
  });

  test('the Sevens Out celebration plays before the race', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 0);
    await expect(page.locator('.fx-banner')).toBeVisible();
    await expect(page.locator('.race')).toHaveCount(0);
    expect(await page.evaluate(() => window.SevensDebug.busy)).toBe(true); // nobody plays on meanwhile
    await expect(page.locator('.race')).toBeVisible();
    await expect(page.locator('.race-badge')).toContainText('Ben cleared all six');
  });

  // serve engine.js changed by `edit`, as a phone with an older copy in its cache would load it
  async function patchEngine(page, edit) {
    const done = { changed: false };
    await page.route('**/engine.js', async route => {
      const res = await route.fetch(), src = await res.text(), body = edit(src);
      done.changed = body !== src;
      await route.fulfill({ response: res, body });
    });
    return done;
  }
  // after round 1 (Anna 10, Ben 20) the page shows round 2 at once, without a race, and play goes on
  async function movesOnWithoutRace(page) {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 20);
    await idle(page);
    await expect(page.locator('.race')).toHaveCount(0);
    await expect(page.locator('#app')).not.toHaveClass(/racing/);
    await openScores(page);
    await expect(page.locator('.board .bhead')).toContainText('Round 2 · Ben starts');
    const s = await saved(page);
    expect([s.phase, s.game.round, s.game.starter]).toEqual(['play', 2, 1]);
    await enterScore(page, 5, 1);
    expect((await saved(page)).game.players.map(p => p.score)).toEqual([10, 25]);
  }

  test('with an engine.js from before the race (an old copy in the cache) the next round starts without a race', async ({ page }) => {
    // the old engine waited in 'roundEnd' for a "Next round" tap and had no roundRecap
    const old = await patchEngine(page, src => src
      .replace('} else startNextRound(s, ev);', "} else { g.next = nextStarter(g); s.phase = 'roundEnd'; ev.push({ type: 'roundEnd', next: g.next }); }")
      .replace('highestLater, roundRecap', 'highestLater'));
    await movesOnWithoutRace(page);
    expect(old.changed).toBe(true);
    expect(await page.evaluate(() => typeof window.SevensEngine.roundRecap)).toBe('undefined');
  });

  test('a round recap or a race that fails shows the next round without a race', async ({ page }) => {
    const fail = await patchEngine(page, src => src.replace('highestLater, roundRecap', "highestLater, roundRecap: () => { throw new Error('test: no recap'); }"));
    await movesOnWithoutRace(page);
    expect(fail.changed).toBe(true);
    await page.unroute('**/engine.js');
    // a recap the race can't draw: it fails once the race is already on screen
    const half = await patchEngine(page, src => src.replace('highestLater, roundRecap', 'highestLater, roundRecap: g => { const r = roundRecap(g); return r && { ...r, after: null }; }'));
    await page.evaluate(() => localStorage.removeItem('sevens-out-v1'));
    await movesOnWithoutRace(page);
    expect(half.changed).toBe(true);
    // the failed race left no key listener behind: Anna's score goes in on the keyboard (and ends round 2)
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.type('7'); await page.keyboard.press('Enter');
    await idle(page);
    const s = await saved(page);
    expect([s.game.round, s.game.players.map(p => p.score)]).toEqual([3, [17, 25]]);
    await expect(page.locator('.race')).toHaveCount(0);
  });

  test('"End game now" mentions the turn in progress only while dice are being rolled', async ({ page, context }) => {
    await fixDice(context, [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);     // no 7s: Anna 6, Ben 12
    await startLocal(page);
    const askEnd = async () => {
      await openMenu(page, 'dev');
      await page.click('[data-act=endearly]');
      const text = await page.locator('[data-fold=dev] .confirm span').innerText();
      await page.click('[data-act=endno]');
      await closeMenu(page);
      return text;
    };
    const plain = 'End the game now? The highest score loses.';
    expect(await askEnd()).toBe(plain);                                // nobody has rolled yet
    await page.click('[data-act=roll]');
    expect(await askEnd()).toBe("End the game now? The highest score loses, and the turn in progress isn't counted.");
    await page.click('[data-act=stop]'); await page.click('[data-act=stop]');
    await page.click('[data-act=roll]'); await page.click('[data-act=end]');   // Ben ends round 1
    await skipRace(page);
    expect((await saved(page)).game.round).toBe(2);
    expect(await askEnd()).toBe(plain);                                // between rounds
  });

  test('the developer menu plays the round change', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1);
    let before = await saved(page);
    await openMenu(page, 'dev');
    await page.click('[data-act=devround]');                    // no round finished yet: made-up points
    await expect(page.locator('.race')).toBeVisible();
    await expect(page.locator('.race-card .pl')).toHaveCount(2);
    await expect(page.locator('.race')).toHaveCount(0);
    await idle(page);
    expect(await saved(page)).toEqual(before);

    await enterScore(page, 20); await skipRace(page);
    before = await saved(page);
    await openMenu(page, 'dev');
    await page.click('[data-act=devround]');                    // the round just finished
    await expect(page.locator('.race-round')).toHaveText('Round 2');
    await expect(page.locator('.race-starter')).toHaveText('Ben starts');
    await expect(page.locator('.race')).toHaveCount(0);
    await idle(page);
    expect(await saved(page)).toEqual(before);
  });
});

// the race card's box (and the list's) at the moment the card is added to the page
const recordRaceStart = page => page.evaluate(() => new MutationObserver((_, o) => {
  const c = document.querySelector('.race-card'); if (!c) return;
  o.disconnect();
  const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const list = document.querySelector('#app .board'), chip = document.querySelector('#app .scorechip');
  window.raceStart = { card: box(c), board: box(list || chip), from: list ? 'list' : chip ? 'chip' : null, scrollY,
    clip: c.style.clipPath, app: document.querySelector('#app').className, chipOpacity: chip && getComputedStyle(chip).opacity };
}).observe(document.body, { childList: true }));
const raceStart = async page => { await expect.poll(() => page.evaluate(() => window.raceStart)).toBeTruthy(); return page.evaluate(() => window.raceStart); };
const sameBox = (a, b) => { for (const k of ['x', 'y', 'width', 'height']) expect(Math.abs(a[k] - b[k]), k).toBeLessThanOrEqual(2); };
// frame by frame: when the curtain drops, when its starter and reason are fully shown, and when it starts to leave
const trackCurtain = page => page.evaluate(() => {
  const t = window.curtain = {};
  const tick = () => {
    const c = document.querySelector('.race-curtain'), now = performance.now();
    if (c && c.classList.contains('in')) {
      if (t.in == null) t.in = now;
      const shown = [...c.querySelectorAll('.race-starter,.race-why')].every(el => getComputedStyle(el).opacity === '1');
      if (shown && t.shown == null) t.shown = now;
      if (c.classList.contains('gone')) t.gone = now;
    }
    if (t.gone == null) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

test('with normal motion the race starts exactly over the score list, and the curtain gives time to read who starts', async ({ page }) => {
  await startLocal(page, { mode: 'score' });
  await enterScore(page, 10, 1);
  // the list opened from the chip; Ben types and saves on the keyboard, so nothing scrolls or closes it
  await openScores(page);
  await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
  const board = await page.locator('.board').boundingBox();
  await recordRaceStart(page);
  await trackCurtain(page);
  await page.keyboard.type('20'); await page.keyboard.press('Enter');
  const start = await raceStart(page);
  expect(start.from).toBe('list');
  sameBox(start.card, board);
  expect(start.scrollY).toBe(0);
  await expect(page.locator('.race')).toHaveCount(0, { timeout: 7000 }); // it ends by itself
  await idle(page);
  expect((await live(page)).game.round).toBe(2);
  await expect(page.locator('.board .bhead')).toContainText('Round 2 · Ben starts');
  // "Ben starts" and the reason stand still on the curtain for at least 0.8 s before it leaves
  const c = await page.evaluate(() => window.curtain);
  expect(c.shown - c.in).toBeLessThan(1000);
  expect(c.gone - c.shown).toBeGreaterThanOrEqual(800);
});

test('a score chip scrolled away comes back into view, and the race starts from it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 460 });                          // a screen too short for the whole turn
  await startLocal(page, { mode: 'score' });
  await enterScore(page, 10, 1);
  await page.click('[data-act=key][data-id="2"]'); await page.click('[data-act=key][data-id="0"]');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));   // down at the bottom of the page
  const away = await page.locator('.scorechip').boundingBox();
  expect(away.y + away.height).toBeLessThan(0);                                     // the chip is off screen
  await recordRaceStart(page);
  await page.click('[data-act=commit]');
  const start = await raceStart(page);
  expect(start.from).toBe('chip');
  expect(Math.abs(start.card.x - start.board.x)).toBeLessThanOrEqual(2);           // it starts from the chip...
  expect(Math.abs(start.card.y - start.board.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(start.card.width - start.board.width)).toBeLessThanOrEqual(2);
  expect(start.board.y).toBeGreaterThanOrEqual(0);                                  // ...which is back in view
  expect(start.board.y).toBeLessThanOrEqual(20);
  await expect(page.locator('.race')).toHaveCount(0, { timeout: 7000 });
  await idle(page);
  await openScores(page);
  await expect(page.locator('.board .bhead')).toContainText('Round 2 · Ben starts');
});

test('no sideways scrolling at phone width, in both looks', async ({ page }) => {
  await page.goto('/');
  expect(await noSideScroll(page)).toBe(true);
  await openSettings(page);
  expect(await noSideScroll(page)).toBe(true);
  await page.click('.sheet-layer [data-act=look][data-id="1"]');
  await closeMenu(page);
  expect(await noSideScroll(page)).toBe(true);
  await page.click('[data-act=play]');
  expect(await noSideScroll(page)).toBe(true);
  await startLocal(page, { names: ['Anna', 'Ben', 'Cleo', 'Dan', 'Eve', 'Finn'] });
  expect(await noSideScroll(page)).toBe(true);
});

test('without color-mix() (iOS 16.1 and older) the current line and the danger hatch still show, in both looks', async ({ page }) => {
  // the page as such a browser reads it: color-mix() is an unknown function, in the rules and in @supports
  await page.route(u => u.pathname === '/', async route => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replaceAll('color-mix(', 'color-old(') });
  });
  await startLocal(page, { mode: 'score' });
  await openScores(page);                                             // the list opens from the chip, over the mat
  expect(await page.evaluate(() => document.querySelector('style').textContent.includes('color-mix('))).toBe(false);
  const look = () => page.evaluate(() => {
    const now = getComputedStyle(document.querySelector('.board .pl.now'));
    return { fill: now.backgroundColor, ring: now.boxShadow, hatch: getComputedStyle(document.querySelector('.board .trk'), '::after').backgroundImage };
  });
  const pub = await look();
  expect(pub.fill).not.toBe('rgba(0, 0, 0, 0)');
  expect(pub.hatch).toContain('repeating-linear-gradient');
  await openMenu(page); await page.click('[data-act=look][data-id="1"]'); await closeMenu(page);
  const vegas = await look();
  expect(vegas.fill).not.toBe('rgba(0, 0, 0, 0)');
  expect(vegas.ring).not.toBe('none');
  expect(vegas.hatch).toContain('repeating-linear-gradient');
});

test.describe('statistics', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const reports = page => page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-reports') || '{"queue":[],"sent":{}}'));

  test('a finished one-phone game is sent once, also when the phone was offline at the end', async ({ page }) => {
    await page.route('**/report', route => route.abort('internetdisconnected'));
    await playShortGame(page);
    await expect.poll(async () => (await reports(page)).queue.length).toBe(1);

    const sent = [];
    await page.unroute('**/report');
    await page.route('**/report', async route => { sent.push(route.request().postDataJSON()); await route.fulfill({ status: 204 }); });
    await page.reload();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].sheet.players).toEqual(['Anna', 'Ben']);
    expect(typeof sent[0].startedAt).toBe('number');
    const check = checkReport(sent[0], globalThis.SevensEngine);
    expect(check.error).toBeUndefined(); // the server would accept it
    expect(check.state.game.loser).toBe(0);
    await expect.poll(async () => (await reports(page)).queue.length).toBe(0);

    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(sent.length).toBe(1);
  });

  test('a report the server refuses is not sent again', async ({ page }) => {
    let calls = 0;
    await page.route('**/report', async route => { calls++; await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"id"}' }); });
    await playShortGame(page);
    await expect.poll(() => calls).toBe(1);
    await expect.poll(async () => (await reports(page)).queue.length).toBe(0); // the answer has been handled
    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(calls).toBe(1);
    expect((await reports(page)).queue).toEqual([]);
  });

  test('a correction after game over sends the game again with the same id', async ({ page }) => {
    const sent = [];
    await page.route('**/report', async route => { sent.push(route.request().postDataJSON()); await route.fulfill({ status: 204 }); });
    await playShortGame(page);
    await expect.poll(() => sent.length).toBe(1);
    await page.click('[data-act=undo]');
    await enterScore(page, 6);
    await expect(page.locator('.verdict')).toContainText('loses');
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].id).toBe(sent[0].id);
    expect(sent[1].sheet.rounds[2].results[1].pts).toBe(6);
  });

  test('a game saved before reports existed is sent under one id, however often the page loads', async ({ page }) => {
    const sent = [];
    await page.route('**/report', async route => { sent.push(route.request().postDataJSON()); await route.fulfill({ status: 204 }); });
    await playShortGame(page);
    await expect.poll(() => sent.length).toBe(1);
    // turn it into an old save: no stats id, and nothing reported yet
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('sevens-out-v1'));
      delete s.stats;
      localStorage.setItem('sevens-out-v1', JSON.stringify(s));
      localStorage.removeItem('sevens-out-reports');
    });
    sent.length = 0;
    for (let i = 0; i < 3; i++) {
      await page.reload();
      await page.waitForLoadState('networkidle');
    }
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent.map(r => r.id)).size).toBe(1);
    expect((await saved(page)).stats.id).toBe(sent[0].id);
  });

  test('damaged report storage does not stop a game from being saved', async ({ page }) => {
    await page.addInitScript(() => { try { if (!localStorage.getItem('sevens-out-reports')) localStorage.setItem('sevens-out-reports', '{"queue":[null,5],"sent":{}}'); } catch (e) {} });
    await page.route('**/report', route => route.fulfill({ status: 204 }));
    await playShortGame(page);
    expect((await saved(page)).phase).toBe('over');
  });
});

test('a game saved between rounds carries on', async ({ page }) => {
  const E = globalThis.SevensEngine;
  let s = must(E.blank(), { type: 'start', names: ['Anna', 'Ben'], starter: 0, mode: 'score' });
  s = must(s, { type: 'score', pts: 10, rolls: 1 });
  s = must(s, { type: 'score', pts: 20 });
  const old = legacyRoundEnd(s);
  await page.addInitScript(v => { try { if (!localStorage.getItem('sevens-out-v1')) localStorage.setItem('sevens-out-v1', v); } catch (e) {} }, JSON.stringify(old));
  await page.goto('/');
  const now = await saved(page);
  expect(now.phase).toBe('play');
  expect(now.game.round).toBe(2);
  expect(now.game.starter).toBe(1);
  await expect(page.locator('[data-act=nextround]')).toHaveCount(0);
  await expect(page.locator('.scorechip .sc-p')).toHaveText(['Ben 20', 'Anna 10']);
});

test.describe('game menu', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('holds the score sheet, how to play, settings, new game and developer; nothing is left under the play screen', async ({ page }) => {
    await startLocal(page);
    await expect(page.locator('#app .foot, #app details.fold')).toHaveCount(0);
    const btn = page.locator('[data-act=menu]');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await btn.click();
    const sheet = page.locator('.sheet-layer .sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#sheet-h')).toHaveText('Game menu');
    await expect(sheet.locator('.sheet-close')).toBeFocused();         // the focus moves in
    await expect(btn).toHaveAttribute('aria-expanded', 'true');
    await expect(sheet.locator('summary')).toHaveText(['Score sheet', 'How to play', 'Developer']);
    await expect(sheet.locator('[data-fold=sheet]')).toHaveAttribute('open', '');
    await expect(sheet.locator('[data-fold=sheet] thead')).toContainText('Anna');
    await expect(sheet.locator('[data-act=sound]')).toHaveCount(3);
    await expect(sheet.locator('[data-act=look]')).toHaveCount(2);
    await expect(sheet.locator('[data-act=new]')).toBeVisible();
    // with reduced motion it appears without sliding
    expect(await sheet.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    expect(await noSideScroll(page)).toBe(true);

    // Escape closes it and the focus goes back to the menu button
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet-layer')).toBeHidden();
    await expect(btn).toBeFocused();
    await expect(btn).toHaveAttribute('aria-expanded', 'false');

    // so do the close button and a tap on the backdrop
    await btn.click(); await sheet.locator('.sheet-close').click();
    await expect(page.locator('.sheet-layer')).toBeHidden();
    await btn.click(); await page.mouse.click(195, 40);                // above the sheet
    await expect(page.locator('.sheet-layer')).toBeHidden();
    await expect(btn).toBeFocused();

    // Tab stays inside the sheet
    await btn.click();
    for (let k = 0; k < 25; k++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.querySelector('.sheet-layer').contains(document.activeElement))).toBe(true);
    }
    // while it is open, the keyboard doesn't reach the game behind it
    await page.keyboard.press('Escape');
  });

  test('New game asks first, then goes back to the setup with the same players', async ({ page }) => {
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo'] });
    await openMenu(page);
    await page.click('[data-act=new]');
    const confirm = page.locator('.sheet-layer .confirm');
    await expect(confirm).toContainText('End this game and go back to the player setup?');
    await page.click('[data-act=newno]');                              // Keep playing
    await expect(confirm).toHaveCount(0);
    await expect(page.locator('.sheet-layer .sheet')).toBeVisible();
    expect((await saved(page)).phase).toBe('play');
    await page.click('[data-act=new]'); await page.click('[data-act=newyes]');
    await expect(page.locator('.sheet-layer')).toBeHidden();
    await expect(page.locator('[data-act=start]')).toBeVisible();
    await expect(page.locator('#name-2')).toHaveValue('Cleo');
    expect((await saved(page)).phase).toBe('setup');
  });

  test('a sound chosen in the menu is kept after a reload', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await openMenu(page);
    const bandit = page.locator('.sheet-layer [data-act=sound][data-id="2"]');
    await bandit.click();
    await expect(bandit).toHaveAttribute('aria-pressed', 'true');
    await expect(bandit).toBeFocused();                                // the redraw keeps the focus on it
    expect(await page.evaluate(() => localStorage.getItem('sevens-out-sound'))).toBe('bandit');
    // typing a digit while the menu is open doesn't enter a score behind it
    await page.keyboard.press('7');
    await page.reload();
    await expect(page.locator('.pad')).toBeVisible();                  // the game carries on
    await openMenu(page);
    await expect(page.locator('.sheet-layer [data-act=sound][data-id="2"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.sheet-layer [data-act=sound][data-id="1"]')).toHaveAttribute('aria-pressed', 'false');
    await closeMenu(page);
    await expect(page.locator('.entry')).toHaveText('–');              // the 7 went nowhere
  });

  test('End game now from the menu closes it and shows the result', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 12, 2);
    await openMenu(page, 'dev');
    await page.click('[data-act=endearly]'); await page.click('[data-act=endyes]');
    await expect(page.locator('.sheet-layer')).toBeHidden();
    await expect(page.locator('.verdict')).toContainText('Anna');
    await expect(page.locator('[data-act=menu]')).toBeFocused();
    await openMenu(page);                                              // the menu works at game over too
    await expect(page.locator('.sheet-layer [data-fold=sheet] tfoot')).toContainText('12');
    await expect(page.locator('.sheet-layer [data-act=new]')).toHaveCount(0); // Play again is on the screen
  });
});

test.describe('the dice turn screen', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const six = ['Anna', 'Ben', 'Cleo', 'Dan', 'Eve', 'Maximilian Long'];
  // a box inside the screen as it is, without scrolling
  const onScreen = async (page, sel) => {
    const [box, h, w] = [await page.locator(sel).boundingBox(), ...(await page.evaluate(() => [innerHeight, innerWidth]))];
    expect(box, sel).not.toBeNull();
    expect(box.y, `${sel} top`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${sel} bottom`).toBeLessThanOrEqual(h + 0.5);
    expect(box.x, `${sel} left`).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, `${sel} right`).toBeLessThanOrEqual(w + 0.5);
  };
  // the pinned bar reaches the bottom edge of the screen
  const barAtBottom = async page => {
    const [box, h] = [await page.locator('#app > .bar').boundingBox(), await page.evaluate(() => innerHeight)];
    expect(Math.abs(box.y + box.height - h)).toBeLessThanOrEqual(1);
  };
  // the chip's content fits inside it on one line (nothing cut off, nothing wrapped)
  const chipFits = async page => {
    const c = page.locator('#app .scorechip');
    const [sw, cw, h] = await c.evaluate(el => [el.scrollWidth, el.clientWidth, el.getBoundingClientRect().height]);
    expect(sw, 'chip content fits').toBeLessThanOrEqual(cw + 0.5);
    expect(h).toBeCloseTo(44, 0);
    const tops = await c.locator('.sc-p').evaluateAll(ps => ps.map(p => Math.round(p.getBoundingClientRect().top)));
    expect(new Set(tops).size, 'one line').toBe(1);
  };
  // a one-phone dice game with these totals, Anna to roll; one player over 101 makes it the last round
  const saveWith = (names, scores) => {
    const E = globalThis.SevensEngine;
    const s = must(E.blank(), { type: 'start', names, starter: 0, mode: 'dice', pairing: 'manual' });
    s.game.players.forEach((p, i) => { p.score = scores[i]; });
    const over = scores.findIndex(v => v >= 101);
    if (over >= 0) Object.assign(s.game, { ending: true, crosser: over });
    return JSON.stringify(s);
  };
  const load = (page, v) => page.addInitScript(x => { try { if (!localStorage.getItem('sevens-out-v1')) localStorage.setItem('sevens-out-v1', x); } catch (e) {} }, v);

  for (const vp of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
    test(`Stop, the round Roll and the rack are on screen without scrolling at ${vp.width}×${vp.height} with six players, in both looks`, async ({ page }) => {
      await page.setViewportSize(vp);
      await startLocal(page, { names: six });
      for (const lookId of ['0', '1']) {
        await openMenu(page); await page.click(`[data-act=look][data-id="${lookId}"]`); await closeMenu(page);
        await page.evaluate(() => scrollTo(0, 0));
        expect(await page.evaluate(() => document.documentElement.classList.contains('felt'))).toBe(true);
        if (!(await saved(page)).game.turn.rolls) {
          await expect(page.locator('.bar [data-act=roll]')).toHaveText('Roll 6 dice');
          await expect(page.locator('.bar .c4left')).toHaveText('Up to 3 rolls');   // plain text, not a button
          await expect(page.locator('.bar .c4left button')).toHaveCount(0);
          await expect(page.locator('.bar .racklabel')).toHaveText('7s land here');
          await onScreen(page, '.bar [data-act=roll]');
          await barAtBottom(page);
          await page.click('[data-act=roll]');
          await page.evaluate(() => scrollTo(0, 0));
        }
        expect(await page.evaluate(() => scrollY)).toBe(0);
        for (const sel of ['.bar [data-act=stop]', '.bar [data-act=roll]', '.bar .rackcell', '#app .scorechip', '.mat .dice', '.mat .hint']) await onScreen(page, sel);
        await barAtBottom(page);
        expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
        // the chip holds all six totals on one line; the full list opens from it and is on screen
        await expect(page.locator('.scorechip .sc-p')).toHaveCount(6);
        await chipFits(page);
        await openScores(page);
        await expect(page.locator('.board .pl')).toHaveCount(6);
        await onScreen(page, '.scores-pop .board');
        await page.keyboard.press('Escape');
        await expect(page.locator('.board')).toHaveCount(0);
        expect(await noSideScroll(page)).toBe(true);
        // the C4 bar: Stop | the 104 px round Roll | the rack, Stop at least 44 px tall
        const [stop, roll, rack] = await Promise.all(['.bar [data-act=stop]', '.bar [data-act=roll]', '.bar .rackcell'].map(sel => page.locator(sel).boundingBox()));
        expect(roll.width).toBeCloseTo(104, 0); expect(roll.height).toBeCloseTo(104, 0);
        expect(stop.height).toBeGreaterThanOrEqual(44);
        expect(stop.x + stop.width).toBeLessThan(roll.x); expect(roll.x + roll.width).toBeLessThan(rack.x);
        expect(Math.abs((stop.x + stop.width / 2 + rack.x + rack.width / 2) / 2 - (roll.x + roll.width / 2))).toBeLessThanOrEqual(1); // Roll in the middle
      }
      // armed: the hint fits on one line above the bar, and nothing scrolls
      await page.click('.bar [data-act=stop]');
      const hint = page.locator('#app > .felt-turn .mat .hint');
      await expect(hint).toContainText('Tap again to stop');
      const [hb, bb] = [await hint.boundingBox(), await page.locator('#app > .bar').boundingBox()];
      const lh = await hint.evaluate(el => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.4);
      expect(hb.height, 'one line').toBeLessThan(lh * 1.5);
      expect(hb.y + hb.height, 'above the bar').toBeLessThanOrEqual(bb.y + 0.5);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    });
  }

  test('the score chip lists every total, the current player marked; the names shorten to 3 letters from four players', async ({ page }) => {
    await load(page, saveWith(['Anna', 'Ben', 'Cleo'], [34, 50, 18]));
    await page.goto('/');
    const chip = page.locator('#app .scorechip');
    await expect(chip.locator('.sc-p')).toHaveText(['Anna 34', 'Ben 50', 'Cleo 18']);   // this round's playing order
    await expect(chip.locator('.sc-p.now')).toHaveText('Anna 34');
    await expect(chip).toHaveAttribute('aria-label', 'Scores: Anna 34, Ben 50, Cleo 18');
    await expect(chip).not.toHaveClass(/\bshort\b/);
    expect(await chip.locator('.sc-p.now').evaluate(el => getComputedStyle(el).fontWeight)).toBe('700');
    await expect(page.locator('.turnhead .eyebrow')).toHaveText('Round 1 · Anna sets the limit');
    await expect(page.locator('.turnhead h2.who')).toHaveText('Anna');
    await expect(page.locator('.turnhead .alert')).toHaveCount(0);
    await chipFits(page);
    // four players: the first three letters of each name; the rest is hidden, not dropped
    await page.evaluate(v => localStorage.setItem('sevens-out-v1', v), saveWith(['Anna', 'Benjamin', 'Cleo', 'Dan'], [12, 7, 0, 3]));
    await page.reload();
    await expect(chip).toHaveClass(/\bshort\b/);
    await expect(chip.locator('.sc-p')).toHaveText(['Anna 12', 'Benjamin 7', 'Cleo 0', 'Dan 3']);
    expect(await chip.locator('.sc-p').evaluateAll(ps => ps.map(p => p.innerText.replace(/\s+/g, ' ')))).toEqual(['Ann 12', 'Ben 7', 'Cle 0', 'Dan 3']);
  });

  for (const look of ['0', '1']) {
    test(`six players at 375 px with long totals: the chip stays on one line, the 101 alert under the name (${look === '0' ? 'Pub table' : 'Vegas'})`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.addInitScript(l => { try { localStorage.setItem('sevens-out-look', l); } catch (e) {} }, look === '0' ? 'pub' : 'vegas');
      await load(page, saveWith(['Anna', 'Benjamin', 'Cleo', 'Dan', 'Eve', 'Maximilian Long'], [88, 104, 95, 100, 79, 99]));
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.scorechip .sc-p')).toHaveCount(6);
      await chipFits(page);
      expect(await noSideScroll(page)).toBe(true);
      await expect(page.locator('.turnhead .alert')).toHaveText('Benjamin is at 104. Last round: the highest score loses.');
      const [who, alert] = [await page.locator('.turnhead h2.who').boundingBox(), await page.locator('.turnhead .alert').boundingBox()];
      expect(alert.y).toBeGreaterThanOrEqual(who.y + who.height - 0.5);
      await onScreen(page, '.bar [data-act=roll]');
      await barAtBottom(page);
    });
  }

  test('the chip opens and closes the full list: the chip again, Escape, or a tap on the mat; the bar acts with it open', async ({ page }) => {
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo'] });
    const chip = page.locator('#app .scorechip'), list = page.locator('#app .scores-pop section.board');
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toHaveCount(0);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    await expect(chip).toHaveAttribute('aria-controls', 'scores');
    await expect(list.locator('li.pl')).toHaveCount(3);
    await expect(chip).toBeFocused();
    // the list lies under the header, over the mat
    const [cb, lb, mat] = await Promise.all([chip.boundingBox(), list.boundingBox(), page.locator('.mat').boundingBox()]);
    expect(lb.y).toBeGreaterThanOrEqual(cb.y + cb.height);
    expect(lb.y).toBeLessThan(mat.y + mat.height);
    await chip.click();                                                // the chip again
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await expect(list).toHaveCount(0);
    await chip.click(); await page.keyboard.press('Escape');           // Escape
    await expect(list).toHaveCount(0);
    await expect(chip).toBeFocused();
    await chip.click();
    const m = await page.locator('.mat').boundingBox();
    await page.mouse.click(m.x + m.width / 2, m.y + m.height - 20);    // a tap on the mat, below the list
    await expect(list).toHaveCount(0);
    expect((await saved(page)).game.turn.rolls).toBe(0);               // ...that does nothing else
    // it stays open across redraws (a roll, a resize, the game menu) until closed
    await chip.click();
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.click('.bar [data-act=roll]');                         // the bar acts with the list open
    await expect.poll(async () => (await saved(page)).game.turn.rolls).toBe(1);
    await expect(list).toBeVisible();
    await expect(list.locator('.pl[data-id="0"]')).toHaveClass(/\bnow\b/);
    await page.click('[data-act=menu]');                               // the menu button too
    await expect(page.locator('#sheet-h')).toHaveText('Game menu');
    await closeMenu(page);
    await expect(list).toBeVisible();
  });

  test('a small phone with six players and two pairs in the rack: the mat and the hint stay above the bar', async ({ page, context }) => {
    await fixDice(context, [1, 6, 2, 5, 3, 3]);                         // two pairs of 7 come out on the first roll
    await page.setViewportSize({ width: 375, height: 667 });
    await startLocal(page, { names: six, pairing: 'auto' });
    await page.click('.bar [data-act=roll]');
    await idle(page);
    await expect(page.locator('.rack .pair')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    const [hint, bar] = [await page.locator('#app > .felt-turn .mat .hint').boundingBox(), await page.locator('#app > .bar').boundingBox()];
    expect(hint.y + hint.height).toBeLessThanOrEqual(bar.y + 0.5);
    for (const b of await page.locator('.rack button.pair, .dice .die').all()) {
      const box = await b.boundingBox();
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44 - 0.5);
    }
    await onScreen(page, '.bar .rackcell');
  });

  test('three pairs fit in the rack cell at 375 px, each one put back with a 44 px button', async ({ page, context }) => {
    await fixDice(context, [1, 6, 2, 5, 3, 4]);
    await page.setViewportSize({ width: 375, height: 667 });
    await startLocal(page, { names: ['Anna', 'Ben'], pairing: 'auto' });
    await page.click('.bar [data-act=roll]');
    await idle(page);
    const cell = await page.locator('.bar .rackcell').boundingBox();
    const pairs = page.locator('.bar .rackcell button.pair[data-act=unpair]');
    await expect(pairs).toHaveCount(3);
    for (const p of await pairs.all()) {
      const b = await p.boundingBox();
      expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44 - 0.5);
      expect(b.x).toBeGreaterThanOrEqual(cell.x - 0.5); expect(b.x + b.width).toBeLessThanOrEqual(cell.x + cell.width + 0.5);
      expect(b.y).toBeGreaterThanOrEqual(cell.y - 0.5); expect(b.y + b.height).toBeLessThanOrEqual(cell.y + cell.height + 0.5);
    }
    // three pairs use the small minis, the put-back buttons too
    expect(await page.locator('.bar .rackcell .die.mini').evaluateAll(ms => ms.map(m => m.getBoundingClientRect().width))).toEqual(Array(6).fill(16));
    await expect(page.locator('.bar [data-act=end]')).toHaveText('End turn +0');   // all six out: End, in the middle
    await onScreen(page, '.bar .rackcell');
    expect(await noSideScroll(page)).toBe(true);
  });

  test('Stop arms first, then confirms; with no rolls left the round button says End', async ({ page, context }) => {
    await fixDice(context, [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);       // no 7s: Anna 12, then Ben 30
    await startLocal(page);
    const eyebrow = page.locator('.turnhead .eyebrow');
    await expect(eyebrow).toHaveText('Round 1 · Anna sets the limit');
    await expect(page.locator('.bar [data-act=stop]')).toHaveCount(0);  // nothing to stop before the first roll
    await expect(page.locator('.bar .c4left')).toHaveText('Up to 3 rolls');
    await expect(page.locator('.bar [data-act=roll]')).toHaveText('Roll 6 dice');
    await page.click('[data-act=roll]');
    await expect(eyebrow).toHaveText('Round 1 · Roll 1 of 3');
    const stop = page.locator('.bar [data-act=stop]');
    await expect(stop).toHaveText('Stop +12');
    await expect(page.locator('.bar [data-act=roll]')).toHaveText('Roll 6 dice');
    await stop.click();
    await expect(stop).toHaveText('Confirm stop +12');                  // "Confirm" on screen, "Confirm stop" for screen readers
    await expect(stop).toHaveClass(/\barmed\b/);
    await expect(page.locator('.mat .hint')).toHaveText('Everyone gets 1 roll. Tap again to stop.');
    await page.click('#app .scorechip');                               // a look at the list keeps it armed
    await expect(stop).toHaveClass(/\barmed\b/);
    await page.keyboard.press('Escape');
    expect((await saved(page)).game.players[0].score).toBe(0);         // not yet
    await stop.click();
    let s = await saved(page);
    expect([s.game.players[0].score, s.game.turn.maxRolls]).toEqual([12, 1]);
    await expect(eyebrow).toHaveText('Round 1 · Up to 1 roll');
    await expect(page.locator('.bar .c4left')).toHaveText('Up to 1 roll');
    await expect(page.locator('.turnhead h2.who')).toHaveText('Ben');
    await expect(page.locator('.scorechip .sc-p.now')).toHaveText('Ben 0');
    await expect(page.locator('.scorechip .sc-p').first()).toHaveText('Anna 12');
    await page.click('[data-act=roll]');
    await expect(page.locator('.bar [data-act=stop], .bar [data-act=roll]')).toHaveCount(0);
    const end = page.locator('.bar [data-act=end]');
    await expect(end).toHaveText('End turn +30');
    await expect(page.locator('.bar .c4left')).toBeEmpty();             // nothing left to stop
    const box = await end.boundingBox();
    expect(box.width).toBeCloseTo(104, 0); expect(box.height).toBeCloseTo(104, 0);
    await end.click();
    await skipRace(page);
    s = await saved(page);
    expect([s.game.round, s.game.players.map(p => p.score)]).toEqual([2, [12, 30]]);
  });

  test('a pair from this roll sits in the rack cell and can be put back; the app finds them on request', async ({ page, context }) => {
    await fixDice(context, [1, 6, 2, 2, 3, 3]);
    await startLocal(page, { pairing: 'auto' });
    await page.click('[data-act=roll]');
    const pair = page.locator('#app > .bar .rackcell .rack button.pair[data-act=unpair]');
    await expect(pair).toHaveCount(1);
    await expect(pair).toHaveAttribute('aria-label', 'Put 1 and 6 back on the table');
    await expect(pair.locator('.die.mini')).toHaveCount(2);
    await expect(page.locator('.bar .racklabel')).toHaveText('set aside');
    await page.click('[data-act=unpair][data-id="0"]');
    await expect(page.locator('.rack .pair')).toHaveCount(0);
    await expect(page.locator('.bar .racklabel')).toHaveText('7s land here');
    await expect(page.locator('.mat [data-act=takeall]')).toBeVisible();   // the app finds them: one tap sets them aside again
    await page.click('[data-act=takeall]');
    await expect(page.locator('.rack .pair')).toHaveCount(1);
    await expect(page.locator('.hint')).toHaveCount(1);                     // one hint line
    // a pair from an earlier roll can't be put back: it is a picture, not a button
    await page.click('.bar [data-act=roll]');
    await expect(page.locator('.rack span.pair[role=img]')).toHaveCount(1);
    await expect(page.locator('.rack span.pair')).toHaveAttribute('aria-label', '1 and 6, set aside in roll 1');
  });

  // ---------- the dice lie at random spots on the mat ----------
  // Math.random from a seed (the dice's spots use it; the dice faces come from crypto)
  const seedRandom = (page, seed) => page.addInitScript(sd => {
    let a = sd;
    Math.random = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }, seed);
  // two rotated squares {cx, cy, s, a (radians)}: the gap along the best separating axis (negative: they overlap)
  const sepGap = (p, q) => {
    const reach = (ux, uy, d) => d.s / 2 * (Math.abs(ux * Math.cos(d.a) + uy * Math.sin(d.a)) + Math.abs(-ux * Math.sin(d.a) + uy * Math.cos(d.a)));
    let best = -Infinity;
    for (const a of [p.a, q.a]) for (const [ux, uy] of [[Math.cos(a), Math.sin(a)], [-Math.sin(a), Math.cos(a)]])
      best = Math.max(best, Math.abs((q.cx - p.cx) * ux + (q.cy - p.cy) * uy) - reach(ux, uy, p) - reach(ux, uy, q));
    return best;
  };
  // the dice as drawn: their boxes, size and tilt, the mat and the hint line
  const drawnDice = page => page.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return { x:r.left, y:r.top, w:r.width, h:r.height }; };
    const mat = box(document.querySelector('#app .mat')), hint = box(document.querySelector('#app .mat .hint'));
    const dice = [...document.querySelectorAll('#app .mat .dice .die')].map(el => {
      const b = box(el), m = new DOMMatrix(getComputedStyle(el).transform);
      return { id:el.dataset.id, box:b, cx:b.x + b.w / 2, cy:b.y + b.h / 2, s:el.offsetWidth, a:Math.atan2(m.b, m.a),
        left:el.style.left, top:el.style.top, rot:el.style.getPropertyValue('--rot') };
    });
    return { mat, hint, dice, scrolled:scrollY };
  });
  // no overlap, at least 8 px inside the mat, above the hint line, tilted at most 20°
  const checkDice = (d, label) => {
    for (const x of d.dice) {
      expect(x.box.x, `${label}: die ${x.id} left`).toBeGreaterThanOrEqual(d.mat.x + 8 - 0.5);
      expect(x.box.x + x.box.w, `${label}: die ${x.id} right`).toBeLessThanOrEqual(d.mat.x + d.mat.w - 8 + 0.5);
      expect(x.box.y, `${label}: die ${x.id} top`).toBeGreaterThanOrEqual(d.mat.y + 8 - 0.5);
      expect(x.box.y + x.box.h, `${label}: die ${x.id} above the hint`).toBeLessThanOrEqual(d.hint.y + 0.5);
      expect(Math.abs(x.a), `${label}: die ${x.id} tilt`).toBeLessThanOrEqual(20 * Math.PI / 180 + 1e-6);
      expect(x.s, `${label}: die ${x.id} size`).toBeGreaterThanOrEqual(48);
    }
    d.dice.forEach((p, i) => d.dice.slice(i + 1).forEach(q => expect(sepGap(p, q), `${label}: dice ${p.id} and ${q.id} apart`).toBeGreaterThanOrEqual(0)));
  };
  const spots = d => Object.fromEntries(d.dice.map(x => [x.id, `${x.left} ${x.top} ${x.rot}`]));

  test('the layout helper: seeded spots never overlap and stay inside the mat, above the foot; the same seed gives the same spots', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(() => {
      const { layout, dieSize } = window.SevensDebug;
      const rng = seed => { let a = seed; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
      const out = [];
      for (const [w, h] of [[390, 553], [375, 386], [375, 336], [320, 287], [320, 240]]) for (const bottom of [64, 114]) for (let n = 1; n <= 6; n++)
        for (const cluster of [false, true]) for (let seed = 1; seed <= 20; seed++) {
          const die = dieSize(w, h, bottom), s = layout(n, w, h, die, rng(seed), { bottom, cluster });
          out.push({ w, h, bottom, die, n, s, again:JSON.stringify(layout(n, w, h, die, rng(seed), { bottom, cluster })) === JSON.stringify(s) });
        }
      // a die put back: new spots around the ones already lying there
      const fixed = layout(4, 390, 553, 86, rng(7), { bottom:64 });
      const more = layout(2, 390, 553, 86, rng(8), { bottom:64, fixed });
      out.push({ w:390, h:553, bottom:64, die:86, n:6, s:[...fixed, ...more], again:true });
      return out;
    });
    expect(r.length).toBeGreaterThan(2000);
    const bad = [];                                                     // collected, so 2000+ layouts check quickly
    for (const c of r) {
      const label = `${c.n} dice on ${c.w}×${c.h} (foot ${c.bottom})`;
      if (c.s.length !== c.n) bad.push(`${label}: ${c.s.length} spots`);
      if (!c.again) bad.push(`${label}: the same seed gave other spots`);
      const sq = c.s.map(p => ({ cx:p.x * c.w, cy:p.y * c.h, s:c.die, a:p.rot * Math.PI / 180, rot:p.rot }));
      for (const q of sq) {
        const e = c.die / 2 * (Math.abs(Math.cos(q.a)) + Math.abs(Math.sin(q.a))), eps = 0.01;
        if (Math.abs(q.rot) > 20) bad.push(`${label}: tilt ${q.rot}`);
        if (q.cx - e < 8 - eps || q.cx + e > c.w - 8 + eps || q.cy - e < 8 - eps || q.cy + e > c.h - c.bottom + eps) bad.push(`${label}: outside at ${q.cx},${q.cy}`);
      }
      const gap = Math.max(6, Math.round(c.die * 0.12));
      sq.forEach((p, i) => sq.slice(i + 1).forEach(q => { if (sepGap(p, q) < gap - 0.01) bad.push(`${label}: overlap`); }));
    }
    expect(bad).toEqual([]);
  });

  for (const vp of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 568 }]) {
    test(`six dice never overlap and stay inside the mat at ${vp.width}×${vp.height}, over 20 seeded rolls`, async ({ page }) => {
      await seedRandom(page, vp.width);
      await page.setViewportSize(vp);
      await startLocal(page, { names: six });
      const seen = new Set();
      for (let rolls = 0; rolls < 20;) {
        if (await page.locator('.bar [data-act=roll]').count()) {
          const before = await drawnDice(page);
          expect(before.dice).toHaveLength(6);
          checkDice(before, `before roll ${rolls + 1}`);
          await page.click('.bar [data-act=roll]');
          rolls++;
          await expect(page.locator('.dice button.die')).toHaveCount(6);   // nothing set aside: you find the 7s
          const d = await drawnDice(page);
          checkDice(d, `roll ${rolls}`);
          seen.add(JSON.stringify(spots(d)));
          expect(d.scrolled).toBe(0);
        } else {
          await page.click('.bar [data-act=end]');
          await skipRace(page);
        }
      }
      expect(seen.size).toBe(20);                                        // every roll lands somewhere new
    });
  }

  test('six players at 375×667 with the 101 alert: the chip on one line, six dice apart inside the mat, Stop, Roll and the rack on screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await seedRandom(page, 375);
    await load(page, saveWith(['Anna', 'Benjamin', 'Cleo', 'Dan', 'Eve', 'Maximilian Long'], [88, 104, 95, 100, 79, 99]));
    await page.goto('/');
    await expect(page.locator('.turnhead .alert')).toBeVisible();
    for (let i = 1; i <= 3; i++) {
      await page.click('.bar [data-act=roll]');
      await expect(page.locator('.turnhead .eyebrow')).toHaveText(`Round 1 · Roll ${i} of 3`);
      const d = await drawnDice(page);
      expect(d.dice).toHaveLength(6);
      checkDice(d, `roll ${i}`);
      await chipFits(page);
      for (const sel of [i < 3 ? '.bar [data-act=stop]' : '.bar [data-act=end]', '.bar .rackcell', '#app .scorechip']) await onScreen(page, sel);
      if (i < 3) await onScreen(page, '.bar [data-act=roll]');
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      expect(await noSideScroll(page)).toBe(true);
    }
  });

  test('the dice stay on their spots through a die tap, a pair put back, the score list and a resize; the next roll draws new spots', async ({ page, context }) => {
    await fixDice(context, [1, 6, 2, 2, 3, 3]);
    await seedRandom(page, 42);
    await startLocal(page, { names: ['Anna', 'Ben'] });
    const cluster = spots(await drawnDice(page));                       // before the first roll: six blank dice lying loosely
    expect(Object.keys(cluster)).toHaveLength(6);
    await expect(page.locator('.dice .die.blank')).toHaveCount(6);
    await page.click('.bar [data-act=roll]');
    const first = await drawnDice(page), at = spots(first);
    expect(first.dice.map(x => x.id)).toEqual(['0', '1', '2', '3', '4', '5']);   // DOM order is the dice's order
    for (const x of first.dice) expect(x.left).toMatch(/%$/);
    expect(at).not.toEqual(cluster);
    const same = async (want, label) => expect(spots(await drawnDice(page)), label).toEqual(want);
    await page.click('.dice [data-act=die][data-id="2"]');               // a die tap selects it
    await expect(page.locator('.dice [data-id="2"]')).toHaveAttribute('aria-pressed', 'true');
    await same(at, 'a die selected');
    await page.click('.dice [data-act=die][data-id="2"]');
    await page.click('.dice [data-act=die][data-id="0"]'); await page.click('.dice [data-act=die][data-id="1"]');   // 1 + 6 set aside
    await expect(page.locator('.dice .die')).toHaveCount(4);             // held dice aren't drawn on the mat
    const rest = Object.fromEntries(Object.entries(at).filter(([id]) => id !== '0' && id !== '1'));
    await same(rest, 'a pair set aside');
    await page.click('.rack [data-act=unpair]');                         // put back: both return to their spots
    await expect(page.locator('.dice .die')).toHaveCount(6);
    await same(at, 'a pair put back');
    await page.click('#app .scorechip');                                 // the score list over the mat, closed with a tap on the mat
    await expect(page.locator('#app .scores-pop .board')).toBeVisible();
    await same(at, 'the list open');
    const m = await page.locator('.mat').boundingBox();
    await page.mouse.click(m.x + 4, m.y + m.height - 4);
    await expect(page.locator('#app .scores-pop')).toHaveCount(0);
    await expect(page.locator('#app .scorechip')).toBeFocused();         // like Escape, the focus goes back to the chip
    await same(at, 'the list closed');
    await page.evaluate(() => window.dispatchEvent(new Event('resize'))); // a resize that changes nothing
    await same(at, 'a resize event');
    await page.setViewportSize({ width: 390, height: 900 });            // a taller mat: the same fractions still fit
    await same(at, 'a taller screen');
    await page.setViewportSize({ width: 375, height: 900 });            // a narrower screen: the dice still lie apart inside the mat
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));   // the resize event has run
    let d = await drawnDice(page);
    expect(d.dice).toHaveLength(6);
    checkDice(d, 'resized to 375 wide');
    await page.setViewportSize({ width: 320, height: 568 });            // much smaller: dice that no longer fit get new spots
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));   // the resize event has run
    d = await drawnDice(page);
    expect(d.dice).toHaveLength(6);
    checkDice(d, 'resized to 320×568');
    const small = spots(d);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await same(small, 'settled after the resize');
    await page.click('.bar [data-act=roll]');
    const next = spots(await drawnDice(page));
    expect(Object.keys(next)).toHaveLength(6);
    expect(Object.keys(next).filter(id => next[id] === at[id])).toHaveLength(0);   // every rolled die lands on a new spot
  });

  test('a new game draws its own spots: it never reuses the last game\'s', async ({ page }) => {
    await seedRandom(page, 9);
    await startLocal(page, { names: ['Anna', 'Ben'] });
    const old = await drawnDice(page);
    expect(old.dice.some(x => x.rot !== '0deg')).toBe(true);             // a loose, tilted cluster
    await openMenu(page);
    await page.click('[data-act=new]'); await page.click('[data-act=newyes]');
    await expect(page.locator('[data-act=start]')).toBeVisible();
    await page.evaluate(() => { Math.random = () => 0.5; });             // from here every new layout is the untilted grid
    await page.click('[data-act=start]');
    const cluster = await drawnDice(page);
    expect(cluster.dice.map(x => x.rot)).toEqual(Array(6).fill('0deg'));   // drawn anew, not the old game's cluster
    checkDice(cluster, 'the new game');
    await page.click('.bar [data-act=roll]');
    expect((await drawnDice(page)).dice.map(x => x.rot)).toEqual(Array(6).fill('0deg'));
  });

  test('reduced motion: the dice appear on their spots at once, with no throw', async ({ page }) => {
    await startLocal(page, { names: ['Anna', 'Ben'] });
    await page.evaluate(() => {
      window.__tumbles = 0;
      new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.querySelector && (n.matches('.tumble') || n.querySelector('.tumble'))) window.__tumbles++; })
        .observe(document.getElementById('app'), { childList: true, subtree: true });
    });
    await page.click('.bar [data-act=roll]');
    await expect(page.locator('.dice button.die')).toHaveCount(6);
    expect(await page.evaluate(() => window.__tumbles)).toBe(0);
    expect(await page.locator('.dice .die').evaluateAll(ds => ds.map(d => d.getAnimations().length + (getComputedStyle(d).animationName === 'none' ? 0 : 1)))).toEqual(Array(6).fill(0));
  });
});

// normal motion: the throw from above the mat, and the pairs flying from their spots into the rack
test.describe('the dice thrown on the mat', () => {
  test('a roll throws the dice from above the mat onto the spots they keep, 40 ms apart', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await startLocal(page, { names: ['Anna', 'Ben'] });
    await page.click('.bar [data-act=roll]');
    const flying = await page.evaluate(() => [...document.querySelectorAll('#app .mat .dice .die.tumble')].map(el => ({
      id:el.dataset.id, name:getComputedStyle(el).animationName, delay:parseFloat(el.style.animationDelay), left:el.style.left, top:el.style.top, rot:el.style.getPropertyValue('--rot') })));
    expect(flying).toHaveLength(6);
    for (const f of flying) expect(f.name).toBe('throw');
    flying.slice(1).forEach((f, k) => expect(f.delay - flying[k].delay).toBe(40));   // staggered by 40 ms, in the dice's order
    await idle(page);
    const landed = await page.evaluate(() => [...document.querySelectorAll('#app .mat .dice .die')].map(el => ({
      id:el.dataset.id, tumble:el.classList.contains('tumble'), anims:el.getAnimations().length, left:el.style.left, top:el.style.top, rot:el.style.getPropertyValue('--rot') })));
    expect(landed.map(l => [l.id, l.left, l.top, l.rot])).toEqual(flying.map(f => [f.id, f.left, f.top, f.rot]));   // they land where they flew to
    for (const l of landed) { expect(l.tumble).toBe(false); expect(l.anims).toBe(0); }
  });

  test('taps on the score chip while the pairs fly out: every pair still flies from its spot on the mat into the rack', async ({ page, context }) => {
    await fixDice(context, [1, 6, 2, 5, 3, 3]);                         // two pairs come out on the first roll
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await startLocal(page, { pairing: 'auto' });
    await page.evaluate(() => {
      window.__fly = []; window.__spots = {};
      new MutationObserver(ms => {
        const mat = document.querySelector('#app .mat');
        if (mat) {
          const r = mat.getBoundingClientRect();
          for (const el of mat.querySelectorAll('.dice .die[data-id]:not(.tumble)'))
            window.__spots[el.dataset.id] = [r.left + parseFloat(el.style.left) / 100 * r.width, r.top + parseFloat(el.style.top) / 100 * r.height];
        }
        for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList.contains('fly')) {
          const s = parseFloat(n.style.getPropertyValue('--die'));
          window.__fly.push([parseFloat(n.style.left) + s / 2, parseFloat(n.style.top) + s / 2]);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.click('.bar [data-act=roll]');
    const chip = page.locator('#app .scorechip');
    for (let i = 0; i < 12; i++) { await chip.click(); await page.waitForTimeout(110); }   // redraws during the throw, the pause and the flights
    await idle(page);
    await expect(page.locator('.rack .pair')).toHaveCount(2);
    await expect(page.locator('.rack .pair.landing')).toHaveCount(0);
    const { fly, spots } = await page.evaluate(() => ({ fly:window.__fly, spots:window.__spots }));
    expect(fly).toHaveLength(4);
    const pts = ['0', '1', '2', '3'].map(id => spots[id]);
    for (const p of pts) expect(p).toBeTruthy();
    // each die flies from its own spot (a lit die is lifted by 8 px), never from a corner
    for (const p of pts) expect(Math.min(...fly.map(f => Math.hypot(f[0] - p[0], f[1] - p[1])))).toBeLessThanOrEqual(10);
  });
});

// the race between rounds starts from the score chip while the list is closed, and from the list when it is open
// (review focus 3), with normal and reduced motion
for (const motion of ['reduce', 'no-preference']) for (const open of [false, true]) {
  test(`dice mode, ${motion === 'reduce' ? 'reduced' : 'normal'} motion, list ${open ? 'open' : 'closed'}: the race starts from the ${open ? 'list' : 'chip'} and brings in the next round`, async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.emulateMedia({ reducedMotion: motion });
    await fixDice(context, Array(18).fill(1));                          // no 7s, so no celebration first (reduced motion)
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo'] });
    for (const who of [0, 1]) {
      await page.click('[data-act=roll]'); await idle(page);
      if (who === 0) { await page.click('[data-act=stop]'); await page.click('[data-act=stop]'); }
      else await page.click('[data-act=end]');
      await idle(page);
    }
    await page.click('[data-act=roll]'); await idle(page);              // Cleo has the last turn of the round
    if (open) await openScores(page);
    await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
    const from = await page.locator(open ? '.board' : '.scorechip').boundingBox();
    await recordRaceStart(page);
    await page.click('.bar [data-act=end]');
    const start = await raceStart(page);
    expect(start.from).toBe(open ? 'list' : 'chip');
    expect(start.app).toMatch(/\bracing-c4\b/);                         // the rest of the screen fades
    expect(start.chipOpacity).toBe('0');
    const w = await page.evaluate(() => innerWidth);
    if (open) {
      // with reduced motion the list has grown by the time the card can be measured: it grows from the list's place
      if (motion === 'reduce') for (const k of ['x', 'y', 'width']) expect(Math.abs(start.card[k] - from[k]), k).toBeLessThanOrEqual(2);
      else sameBox(start.card, from);
    } else if (motion === 'reduce') {
      // grown at once: the list's width, from the chip's top
      expect(Math.abs(start.card.x - 16)).toBeLessThanOrEqual(2);
      expect(Math.abs(start.card.width - (w - 32))).toBeLessThanOrEqual(2);
      expect(Math.abs(start.card.y - Math.max(16, from.y))).toBeLessThanOrEqual(2);
    } else {
      // the card starts exactly over the chip, clipped to the chip's height, and grows down from it
      for (const k of ['x', 'y', 'width']) expect(Math.abs(start.card[k] - from[k]), k).toBeLessThanOrEqual(2);
      expect(start.clip).toContain('inset(0px 0px calc(100% - 44px) round 22px)');
    }
    const shown = await page.evaluate(() => [document.querySelectorAll('.race-card .pl').length,
      ...[...document.querySelectorAll('.race-round, .race-starter')].map(el => el.textContent)]);
    await expect(page.locator('.race')).toHaveCount(0, { timeout: 7000 }); // it ends by itself
    await idle(page);
    await expect(page.locator('#app')).not.toHaveClass(/racing/);
    // with normal motion the tumbling dice draw random faces too, so the fixed dice may land elsewhere: read who starts
    const g = (await live(page)).game, next = g.players[g.starter].name;
    expect(shown).toEqual([3, 'Round 2', `${next} starts`]);
    expect(g.round).toBe(2);
    await expect(page.locator('.turnhead .eyebrow')).toContainText('Round 2');
    await expect(page.locator('.turnhead h2.who')).toHaveText(next);
    // the list keeps its state across the round change
    if (open) await expect(page.locator('.scores-pop .board .bhead')).toContainText(`Round 2 · ${next} starts`);
    else await expect(page.locator('.board')).toHaveCount(0);
    await expect(page.locator('.bar [data-act=roll]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains('felt'))).toBe(true);
    expect(errors).toEqual([]);
  });
}

test.describe('the real-dice turn, corrections and game over', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const six = ['Anna', 'Ben', 'Cleo', 'Dan', 'Eve', 'Maximilian Long'];
  const onScreen = async (page, sel) => {
    const [box, h, w] = [await page.locator(sel).boundingBox(), ...(await page.evaluate(() => [innerHeight, innerWidth]))];
    expect(box, sel).not.toBeNull();
    expect(box.y, `${sel} top`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${sel} bottom`).toBeLessThanOrEqual(h + 0.5);
    expect(box.x + box.width, `${sel} right`).toBeLessThanOrEqual(w + 0.5);
  };
  const barAtBottom = async page => {
    const [box, h] = [await page.locator('#app > .bar').boundingBox(), await page.evaluate(() => innerHeight)];
    expect(Math.abs(box.y + box.height - h)).toBeLessThanOrEqual(1);
  };

  for (const vp of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
    test(`Save stays pinned on screen at ${vp.width}×${vp.height} with six players, in both looks; the chip shows all six totals`, async ({ page }) => {
      await page.setViewportSize(vp);
      await startLocal(page, { names: six, mode: 'score' });
      for (let turn = 0; turn < 2; turn++) {                           // the starter (rolls used) and then a player who isn't
        for (const lookId of ['0', '1']) {
          await openMenu(page); await page.click(`[data-act=look][data-id="${lookId}"]`); await closeMenu(page);
          expect(await page.evaluate(() => document.documentElement.classList.contains('felt'))).toBe(true);
          // the chip on one line with every total, in this round's playing order
          const g = (await saved(page)).game;
          expect(await page.locator('#app .scorechip .sc-p b').allTextContents()).toEqual(g.order.map(i => String(g.players[i].score)));
          const chipBox = await page.locator('#app .scorechip').boundingBox();
          expect(chipBox.height).toBeLessThanOrEqual(44.5);
          expect(await page.evaluate(() => { const c = document.querySelector('#app .scorechip'); return c.scrollWidth <= c.clientWidth + 0.5; })).toBe(true);
          await expect(page.locator('#app .board')).toHaveCount(0);   // the full list is one tap away
          await page.click('[data-act=clear]');
          await page.click('[data-act=key][data-id="7"]');
          if (turn === 0) await page.click('[data-act=rolls][data-id="2"]');
          await expect(page.locator('.bar [data-act=commit]')).toBeEnabled();
          await expect(page.locator('.bar [data-act=commit]')).toContainText(/^Save · \w+ \+7$/);
          for (const sel of ['.key', '.segbtn', '[data-act=drop]']) {
            for (const b of await page.locator(`#app ${sel}`).all()) expect((await b.boundingBox()).height, sel).toBeGreaterThanOrEqual(44 - 0.5);
          }
          // Save is pinned: it is on screen with the chip at the top of the page, and the mat scrolls under the bar
          await page.evaluate(() => scrollTo(0, 0));
          await onScreen(page, '.bar [data-act=commit]');
          await barAtBottom(page);
          await onScreen(page, '#app .scorechip');
          expect(await noSideScroll(page)).toBe(true);
          expect((await page.locator('.bar [data-act=commit]').boundingBox()).height).toBeGreaterThanOrEqual(44);
          await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
          await onScreen(page, '.bar [data-act=commit]');
          await barAtBottom(page);
          const bar = await page.locator('#app > .bar').boundingBox();
          for (const sel of ['.floor [data-act=drop]', '.keymat .key[data-act=back]']) {
            const b = await page.locator(sel).boundingBox();
            expect(b.y + b.height, sel).toBeLessThanOrEqual(bar.y + 0.5);   // reachable above the bar
          }
        }
        await page.click('[data-act=commit]');
      }
    });
  }

  test('the real-dice screen: the C4 frame, entry and keypad on the mat, rolls used for the starter only, Undo above the bar', async ({ page }) => {
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo'], mode: 'score' });
    await expect(page.locator('#app > .chiprow .scorechip .sc-p')).toHaveText(['Anna 0', 'Ben 0', 'Cleo 0']);
    await expect(page.locator('.scorechip .sc-p.now')).toHaveText('Anna 0');
    await expect(page.locator('.keyturn .turnhead.c4 .eyebrow')).toHaveText('Round 1 · Starts the round · up to 3 rolls');
    await expect(page.locator('.keyturn .turnhead.c4 h2.who')).toHaveText('Anna');
    expect(await page.evaluate(() => document.documentElement.classList.contains('felt'))).toBe(true);
    await expect(page.locator('.keyturn > .mat.keymat .entry-top .tlabel')).toHaveText(['Pips left on the table', '0–36']);
    await expect(page.locator('.mat.keymat .pad .key')).toHaveCount(12);
    for (const sel of ['.rollpick', '.floor', '.hintrow']) await expect(page.locator(`.mat.keymat > ${sel}`)).toHaveCount(1);
    for (const b of await page.locator('.mat.keymat .key').all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44 - 0.5);
    // Save in the C4 footer: leather-deep with a 28 px top radius
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#app > .bar.c4save')).borderTopLeftRadius)).toBe('28px');
    await expect(page.locator('.floor')).toContainText('Dice on the floor');
    await expect(page.locator('[data-act=undo]')).toHaveCount(0);
    const save = page.locator('.bar [data-act=commit]');
    await expect(save).toBeDisabled(); await expect(save).toHaveText('Enter the pips left');
    await page.click('[data-act=key][data-id="1"]'); await page.click('[data-act=key][data-id="2"]');
    await expect(save).toBeDisabled(); await expect(save).toHaveText('Choose the rolls used');
    await page.click('[data-act=rolls][data-id="2"]');
    await expect(save).toHaveText('Save · Anna +12');
    await save.click();
    await expect(page.locator('[data-act=rolls]')).toHaveCount(0);       // only the starter chooses the rolls
    await expect(page.locator('.turnhead .eyebrow')).toHaveText('Round 1 · Up to 2 rolls');
    await expect(page.locator('.scorechip .sc-p')).toHaveText(['Anna 12', 'Ben 0', 'Cleo 0']);
    // three players fit on a 390×844 phone: without scrolling, Undo is on screen above the bar
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await expect(page.locator('[data-act=undo]')).toBeInViewport();
    const undo = await page.locator('[data-act=undo]').boundingBox(), bar = await page.locator('#app > .bar').boundingBox();
    expect(undo.y + undo.height).toBeLessThanOrEqual(bar.y + 0.5);       // above the bar
    await page.click('[data-act=undo]');
    await expect(page.locator('.bar [data-act=commit]')).toHaveText('Enter the pips left');
    // the next round's starter has Rolls used and Undo too: still no scrolling with three players
    await enterScore(page, 12, 2); await enterScore(page, 5); await enterScore(page, 7);
    await skipRace(page);
    await expect(page.locator('[data-act=rolls]')).toHaveCount(3);
    await expect(page.locator('[data-act=undo]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    const undo2 = await page.locator('[data-act=undo]').boundingBox(), bar2 = await page.locator('#app > .bar').boundingBox();
    expect(undo2.y + undo2.height).toBeLessThanOrEqual(bar2.y + 0.5);
  });

  test('every line of the real-dice list is a real 44 px tap target, also with six players', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await startLocal(page, { names: six, mode: 'score' });
    await openScores(page);                                             // the list opens from the chip, over the mat
    await expect(page.locator('.board')).toHaveClass(/\btall\b/);
    // hit-test each row at its centre and 21 px above and below it: it must be that row that answers
    const bad = await page.evaluate(() => {
      const out = [];
      for (const li of document.querySelectorAll('.board .pl.editable')) {
        li.scrollIntoView({ block: 'center' });
        const r = li.getBoundingClientRect(), x = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (r.height < 44 - 0.5) out.push([li.dataset.id, 'height', r.height]);
        for (const dy of [-21, 0, 21]) {
          const hit = document.elementFromPoint(x, cy + dy);
          if (!hit || hit.closest('li.pl') !== li) out.push([li.dataset.id, dy]);
        }
      }
      return out;
    });
    expect(bad).toEqual([]);
    await page.evaluate(() => scrollTo(0, 0));
    await expect(page.locator('.board .pl')).toHaveCount(6);
    await onScreen(page, '.bar [data-act=commit]');
    const last = await page.locator('.board .pl').last().boundingBox();
    await page.mouse.click(last.x + last.width / 2, last.y + last.height / 2 + 20);
    await expect(page.locator('#edit-h')).toHaveText('Maximilian Long');
  });

  test('a correction starts from a line in the chip\'s list and comes back to the turn', async ({ page }) => {
    await startLocal(page, { names: ['Anna', 'Ben', 'Cleo'], mode: 'score' });
    await enterScore(page, 10, 1);
    await page.click('#app .scorechip');
    const line = page.locator('#app > .chiprow .scores-pop .board .pl.editable[data-id="0"]');
    await expect(line).toHaveAttribute('aria-label', "Correct Anna's scores");
    await line.click();
    // corrections stay on paper, with the slim header and the full list
    await expect(page.locator('#edit-h')).toHaveText('Anna');
    expect(await page.evaluate(() => document.documentElement.classList.contains('felt'))).toBe(false);
    await expect(page.locator('#app .scorechip')).toHaveCount(0);
    await expect(page.locator('.rnd')).toHaveText('Round 1 · 1 roll max');
    await expect(page.locator('#app > .board .pl')).toHaveCount(3);
    await page.fill('#edit-1', '4');
    await page.click('[data-act=esave]');
    await expect(page.locator('.keyturn h2.who')).toHaveText('Ben');
    await expect(page.locator('.scorechip')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.scorechip .sc-p')).toHaveText(['Anna 4', 'Ben 0', 'Cleo 0']);
    expect((await saved(page)).game.players[0].score).toBe(4);
    // a keyboard user: Enter on a line opens it too
    await openScores(page);
    await page.locator('.scores-pop .pl[data-id="0"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#edit-h')).toHaveText('Anna');
    await page.click('[data-act=ecancel]');
    await expect(page.locator('.bar [data-act=commit]')).toBeVisible();
  });

  test('corrections: Save changes and Cancel are pinned to the bottom, also on a short phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await startLocal(page, { names: six, mode: 'score' });
    await enterScore(page, 10, 1);
    await editLine(page, 0);
    expect(await page.evaluate(() => document.documentElement.classList.contains('felt'))).toBe(false);   // corrections stay on paper
    const save = page.locator('.bar [data-act=esave]'), cancel = page.locator('.bar [data-act=ecancel]');
    await expect(save).toBeDisabled();
    await onScreen(page, '.bar [data-act=esave]'); await onScreen(page, '.bar [data-act=ecancel]');
    await barAtBottom(page);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await expect(page.locator('.board .pl')).toHaveCount(6);
    await page.fill('#edit-1', '14');
    await expect(save).toBeEnabled();
    expect((await save.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await save.click();
    await expect(page.locator('.scorechip .sc-p').first()).toHaveText('Anna 14');   // back on the turn, the list closed
    await expect(page.locator('.scorechip')).toHaveAttribute('aria-expanded', 'false');
    await editLine(page, 0);
    await cancel.click();
    await expect(page.locator('.bar [data-act=commit]')).toBeVisible();
  });

  for (const vp of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
    test(`game over: Play again is pinned at ${vp.width}×${vp.height}, with the list sorted and Undo above the bar`, async ({ page }) => {
      await page.setViewportSize(vp);
      await playShortGame(page);
      const again = page.locator('.bar [data-act=again]');
      await expect(again).toHaveText('Play again');
      await onScreen(page, '.bar [data-act=again]');
      await barAtBottom(page);
      expect((await again.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.classList.contains('felt'))).toBe(false);
      expect(await page.locator('.board .pl .nm').allTextContents()).toEqual(['Anna', 'Ben']);
      await expect(page.locator('.board .pl.lost .dl')).toHaveText('Loses');
      const undo = await page.locator('[data-act=undo]').boundingBox(), bar = await page.locator('#app > .bar').boundingBox();
      expect(undo.y + undo.height).toBeLessThanOrEqual(bar.y + 0.5);
      expect(await noSideScroll(page)).toBe(true);
      await again.click();
      await expect(page.locator('[data-act=start]')).toBeVisible();
    });
  }
});

test.describe('home and the Play sheet', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('home C1: the settings button, the title, Play and the room code row; no tab bar anywhere', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app [data-act=play]')).toHaveText('Play');
    const settings = page.locator('.home-head [data-act=settings]');
    await expect(settings).toHaveAttribute('aria-label', 'Settings');
    await expect(page.locator('.home-head [data-act=profile]')).toHaveCount(0);       // 127.0.0.1: no accounts here
    await expect(page.locator('#ocode')).toHaveAttribute('placeholder', 'Got a room code?');
    await expect(page.locator('#ocode')).toHaveAttribute('maxlength', '5');
    await expect(page.locator('label[for=ocode]')).toHaveText('Room code');
    await expect(page.locator('.code-row [data-act=ojoin]')).toHaveText('Join');
    await expect(page.locator('.acct, [data-act=start], [data-act=mode], details.fold, [data-act=ocreate]')).toHaveCount(0);
    await expect(page.locator('nav.tabbar')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.classList.contains('felt'))).toBe(true);
    for (const vp of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
      await page.setViewportSize(vp);
      const s = await settings.boundingBox(), play = await page.locator('[data-act=play]').boundingBox();
      const code = await page.locator('#ocode').boundingBox(), join = await page.locator('.code-row [data-act=ojoin]').boundingBox();
      expect(Math.min(s.width, s.height)).toBeGreaterThanOrEqual(44);
      expect(join.height).toBeGreaterThanOrEqual(44);
      expect(s.y).toBeLessThan(80);                                                   // the header on top
      expect(play.y).toBeGreaterThan(vp.height / 2);                                  // Play in the thumb zone...
      expect(code.y).toBeGreaterThan(play.y + play.height);                           // ...the code row under it...
      expect(code.y + code.height).toBeLessThanOrEqual(vp.height);                    // ...on screen, without scrolling
      expect(Math.abs(code.y - join.y)).toBeLessThanOrEqual(1);
      expect(await noSideScroll(page)).toBe(true);
    }
    // the code field takes letters and digits only, in capitals
    await page.fill('#ocode', 'k7-q');
    await expect(page.locator('#ocode')).toHaveValue('K7Q');
    await startLocal(page);
    await expect(page.locator('nav.tabbar')).toHaveCount(0);
    await openMenu(page);
    await page.click('.sheet-layer [data-act=new]');
    await page.click('.sheet-layer [data-act=newyes]');                 // New game: Who's playing, then back home
    await expect(page.locator('[data-act=start]')).toBeVisible();
    await page.click('.menubtn[data-act=home]');
    await expect(page.locator('.home-head [data-act=settings]')).toBeVisible();
    await expect(page.locator('nav.tabbar')).toHaveCount(0);
  });

  test('the Settings sheet changes sound and look, and How to play and Developer fold open', async ({ page }) => {
    await page.goto('/');
    const settings = page.locator('.home-head [data-act=settings]');
    await openSettings(page);
    await expect(settings).toHaveAttribute('aria-expanded', 'true');
    const sheet = page.locator('.sheet-layer .sheet');
    await sheet.locator('[data-act=sound][data-id="2"]').click();
    await expect(sheet.locator('[data-act=sound][data-id="2"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('sevens-out-sound'))).toBe('bandit');
    await sheet.locator('[data-act=look][data-id="1"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-look', 'vegas');
    expect(await page.evaluate(() => localStorage.getItem('sevens-out-look'))).toBe('vegas');
    await expect(sheet.locator('[data-act=shake]')).toHaveCount(0); // a desktop pointer: no shake setting
    for (const f of ['rules', 'dev']) {
      const d = sheet.locator(`details[data-fold=${f}]`);
      await d.locator('summary').click();
      await expect(d).toHaveAttribute('open', '');
    }
    expect(await noSideScroll(page)).toBe(true);
    await page.keyboard.press('Escape');                                // closes; the focus goes back to the settings button
    await expect(page.locator('.sheet-layer')).toBeHidden();
    await expect(settings).toBeFocused();
    await page.reload();                                                // the choices are kept
    await expect(page.locator('html')).toHaveAttribute('data-look', 'vegas');
    await openSettings(page);
    await expect(page.locator('.sheet-layer [data-act=sound][data-id="2"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the Play sheet: choices are kept in state.setup, the switch sets the 7s, Next leads to Who\'s playing', async ({ page }) => {
    await page.goto('/');
    const play = page.locator('[data-act=play]');
    await play.click();
    const sheet = page.locator('.sheet-layer .sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('role', 'dialog');
    await expect(play).toHaveAttribute('aria-expanded', 'true');
    await expect(sheet.locator('legend')).toHaveText(['Where is everyone?', 'Dice']);
    await expect(page.locator('[data-act=where][data-id="0"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-act=mode][data-id="0"]')).toHaveAttribute('aria-pressed', 'true');
    const sw = page.locator('.sheet-layer [role=switch][data-act=pairing]');
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await expect(sheet).toContainText('Off: you spot them, and missed pairs count');
    expect((await saved(page)).setup.pairing).toBe('manual');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    expect((await saved(page)).setup.pairing).toBe('auto');
    await sw.click();
    expect((await saved(page)).setup.pairing).toBe('manual');
    await sw.click();                                                   // auto again, for the game below
    expect(await noSideScroll(page)).toBe(true);
    for (const h of await sheet.locator('.opt, [data-act=players]').evaluateAll(els => els.map(el => el.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
    // the switch is drawn 32px tall; its real hit area (a taller ::before) must reach 44px
    const swBox = await sw.boundingBox();
    const reach = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return !!el && !!el.closest('[data-act=pairing]'); }, { x: swBox.x + swBox.width / 2, y: swBox.y });
    expect(reach).toBe(true);
    let up = 0, down = 0;
    for (let d = 0; d <= 12; d++) {
      const hit = dy => page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return !!el && !!el.closest('[data-act=pairing]'); }, { x: swBox.x + swBox.width / 2, y: dy });
      if (await hit(swBox.y - d)) up = d;
      if (await hit(swBox.y + swBox.height + d - 1)) down = d;
    }
    expect(swBox.height + up + down).toBeGreaterThanOrEqual(44);

    // real dice: no switch; the choice is saved and survives a reload
    await page.click('[data-act=mode][data-id="1"]');
    await expect(sw).toHaveCount(0);
    expect((await saved(page)).setup).toMatchObject({ mode: 'score', pairing: 'auto' });
    await page.keyboard.press('Escape');                               // Escape closes it, the focus goes back to Play
    await expect(page.locator('.sheet-layer')).toBeHidden();
    await expect(play).toBeFocused();
    await page.reload();
    await play.click();
    await expect(page.locator('[data-act=mode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
    await page.click('[data-act=mode][data-id="0"]');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await page.click('[data-act=players]');
    await expect(page.locator('.sheet-layer')).toBeHidden();
    await expect(page.locator('[data-act=start]')).toBeVisible();
    await page.fill('#name-0', 'Anna'); await page.fill('#name-1', 'Ben');
    await page.click('[data-act=start]');
    const g = (await saved(page)).game;
    expect([g.mode, g.pairing]).toEqual(['dice', 'auto']);
  });

  test('without a server there is no room code row and no "Where is everyone?"', async ({ page }) => {
    await page.route(u => u.pathname === '/', async route => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).replace(/(name="sevens-out-server" content=")[^"]*"/, '$1"') });
    });
    await page.goto('/');
    await expect(page.locator('.home-head [data-act=settings]')).toBeVisible();
    await expect(page.locator('.code-row, #ocode, [data-act=ojoin]')).toHaveCount(0); // no room code row without online
    await page.click('[data-act=play]');
    await expect(page.locator('.sheet-layer legend')).toHaveText(['Dice']);
    await expect(page.locator('[data-act=where]')).toHaveCount(0);
    await expect(page.locator('[data-act=players]')).toBeVisible();
  });

  test('an old saved setup without the new fields opens home and the sheet with its choices', async ({ page }) => {
    const old = { phase: 'setup', setup: { names: ['Zed', 'Yan'], starter: 1, mode: 'score', pairing: 'manual' }, game: null };
    await page.addInitScript(v => { try { if (!localStorage.getItem('sevens-out-v1')) localStorage.setItem('sevens-out-v1', v); } catch (e) {} }, JSON.stringify(old));
    await page.goto('/');
    await page.click('[data-act=play]');
    await expect(page.locator('[data-act=where][data-id="0"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-act=mode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
    await page.click('[data-act=players]');
    await expect(page.locator('#name-0')).toHaveValue('Zed');
    await expect(page.locator('#starter-1')).toBeChecked();
  });
});

test.describe("Who's playing", () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('the players card: starter dice, names, remove, add, random, the mode row and a pinned Start', async ({ page }) => {
    await page.goto('/');
    await toPlayers(page);
    await expect(page.locator('h1#players-h')).toHaveText("Who's playing");
    await expect(page.locator('[data-act=home][aria-label=Back]')).toBeVisible();
    await expect(page.locator('.pcard .prow')).toHaveCount(2);
    await expect(page.locator('.hint')).toHaveText('The die marks who starts round 1.');
    await expect(page.locator('[data-act=play]')).toContainText('Dice in the app · You find the 7s');
    await page.fill('#name-0', 'Anna'); await page.fill('#name-1', 'Ben');
    await expect(page.locator('#starter-0')).toHaveAttribute('aria-label', 'Anna starts');
    await expect(page.locator('#starter-1')).toHaveAttribute('aria-label', 'Let Ben start');
    await page.check('#starter-1');
    await expect(page.locator('#starter-0')).toHaveAttribute('aria-label', 'Let Anna start');
    await expect(page.locator('#starter-1')).toHaveAttribute('aria-label', 'Ben starts');
    expect((await saved(page)).setup.starter).toBe(1);
    // two players: no remove; three: remove on every row
    await expect(page.locator('[data-act=remove]')).toHaveCount(0);
    await page.click('[data-act=add]');
    await expect(page.locator('[data-act=remove]')).toHaveCount(3);
    await page.fill('#name-2', 'Cleo');
    // tap sizes
    const sizes = await page.locator('.pcard .diepick, .pcard [data-act=remove], .pcard .name-in, .addrow, [data-act=randstart], [data-act=home], [data-act=play]').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return [r.width, r.height]; }));
    for (const [w, h] of sizes) { expect(h).toBeGreaterThanOrEqual(44); expect(w).toBeGreaterThanOrEqual(44); }
    expect(await noSideScroll(page)).toBe(true);
    const startBox = await page.locator('.bar [data-act=start]').boundingBox();
    expect(startBox.y + startBox.height).toBeLessThanOrEqual(844);
    await page.click('[data-act=randstart]');
    await expect(page.locator('.hint')).toContainText('starts the first round');
    await page.click('[data-act=remove][data-id="2"]');
    await expect(page.locator('.pcard .prow')).toHaveCount(2);
    // the mode row opens the Play sheet; real dice shows in the row
    await page.click('[data-act=play]');
    await expect(page.locator('.sheet-layer .sheet')).toBeVisible();
    await page.click('[data-act=mode][data-id="1"]');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-act=play]')).toContainText('Real dice · Scores here');
    await expect(page.locator('[data-act=play]')).toBeFocused();
    await page.click('[data-act=home]');
    await expect(page.locator('[data-act=play].play')).toBeVisible();
  });

  test('a hint left on Who\'s playing does not come back when you return', async ({ page }) => {
    await page.goto('/');
    await toPlayers(page);
    await page.click('[data-act=randstart]');
    await expect(page.locator('.hint')).toContainText('starts the first round');
    await page.click('[data-act=home]');
    await page.click('[data-act=play]'); await page.click('[data-act=players]');
    await expect(page.locator('.hint')).toHaveText('The die marks who starts round 1.');
  });

  test('Play again and New game land here with the same players and mode', async ({ page }) => {
    await playShortGame(page);
    await page.click('[data-act=again]');
    await expect(page.locator('h1#players-h')).toBeVisible();
    await expect(page.locator('#name-0')).toHaveValue('Anna');
    await expect(page.locator('#name-1')).toHaveValue('Ben');
    await expect(page.locator('[data-act=play]')).toContainText('Real dice');
    await page.click('[data-act=start]');
    await expect(page.locator('.scorechip')).toBeVisible();
    await openMenu(page);
    await page.click('[data-act=new]'); await page.click('[data-act=newyes]');
    await expect(page.locator('#name-0')).toHaveValue('Anna');
    await expect(page.locator('[data-act=play]')).toContainText('Real dice');
  });

  test('a game saved mid-turn before this change loads into the turn; an old setup loads home and this screen', async ({ page }) => {
    const E = globalThis.SevensEngine;
    let s = must(E.blank(), { type: 'start', names: ['Anna', 'Ben'], starter: 0, mode: 'score' });
    s = must(s, { type: 'score', pts: 10, rolls: 1 });
    await page.addInitScript(v => { try { if (!localStorage.getItem('sevens-out-v1')) localStorage.setItem('sevens-out-v1', v); } catch (e) {} }, JSON.stringify(s));
    await page.goto('/');
    await expect(page.locator('.scorechip .sc-p')).toHaveText(['Anna 10', 'Ben 0']);
    await expect(page.locator('.bar [data-act=commit]')).toBeVisible();
    await expect(page.locator('[data-act=play].play')).toHaveCount(0);
  });

  test('a small phone with six players: Start stays pinned on screen while the card scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await toPlayers(page);
    for (let i = 2; i < 6; i++) await page.click('[data-act=add]');
    await expect(page.locator('.pcard .prow')).toHaveCount(6);
    for (const y of [0, 'end']) {
      await page.evaluate(v => scrollTo(0, v === 'end' ? document.documentElement.scrollHeight : v), y);
      const [box, h] = [await page.locator('#app > .bar [data-act=start]').boundingBox(), await page.evaluate(() => innerHeight)];
      expect(box.y, `top (${y})`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, `bottom (${y})`).toBeLessThanOrEqual(h + 0.5);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    // the last row and the mode row are reachable above the bar
    const bar = await page.locator('#app > .bar').boundingBox();
    for (const sel of ['#name-5', '#app [data-act=play]']) {
      const b = await page.locator(sel).boundingBox();
      expect(b.y + b.height, sel).toBeLessThanOrEqual(bar.y + 0.5);
    }
    expect(await noSideScroll(page)).toBe(true);
    await page.click('[data-act=start]');
    await openScores(page);
    await expect(page.locator('.board .pl')).toHaveCount(6);
  });

  test('a literal save from an older page, mid-turn, opens the dice turn and plays on', async ({ page }) => {
    // written by hand as a page from before 7s by hand, the floor counter, statistics and the Play sheet saved it:
    // no setup.pairing/where, no game.pairing/drops/shots, no stats; Ben's turn, one roll made and one pair set aside
    const old = '{"phase":"play","setup":{"names":["Anna","Ben"],"starter":0,"mode":"dice"},"game":{"mode":"dice","history":[],'
      + '"players":[{"name":"Anna","score":9},{"name":"Ben","score":0}],"round":1,"starter":0,"order":[0,1],"pos":1,"mark":2,'
      + '"ending":false,"crosser":null,"next":null,"loser":null,"last":null,'
      + '"rounds":[{"no":1,"starter":0,"mark":2,"results":{"0":{"pts":9,"rolls":2}}}],'
      + '"turn":{"dice":[{"id":0,"value":3,"held":1},{"id":1,"value":4,"held":1},{"id":2,"value":2,"held":null},{"id":3,"value":2,"held":null},{"id":4,"value":6,"held":null},{"id":5,"value":6,"held":null}],'
      + '"rolls":1,"maxRolls":2,"pairs":[{"a":0,"b":1,"roll":1}]}}}';
    await page.addInitScript(v => { try { if (!localStorage.getItem('sevens-out-v1')) localStorage.setItem('sevens-out-v1', v); } catch (e) {} }, old);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.classList.contains('felt'))).toBe(true);
    await expect(page.locator('.scorechip .sc-p')).toHaveText(['Anna 9', 'Ben 0']);
    await openScores(page);
    await expect(page.locator('.board .pl')).toHaveCount(2);
    await expect(page.locator('h2.who')).toContainText('Ben');
    await expect(page.locator('.turnhead .eyebrow')).toHaveText('Round 1 · Roll 1 of 2');
    await expect(page.locator('.rack .pair')).toHaveCount(1);
    await expect(page.locator('.bar [data-act=stop]')).toHaveText('Stop +16');
    await expect(page.locator('.bar [data-act=roll]')).toHaveText('Roll 4 dice');
    await expect(page.locator('nav.tabbar')).toHaveCount(0);
    await page.click('.bar [data-act=roll]');
    await expect.poll(async () => (await saved(page)).game.turn.rolls).toBe(2);
    await expect(page.locator('.bar [data-act=end]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a saved setup without the new fields loads home, then this screen with its names', async ({ page }) => {
    const old = { phase: 'setup', setup: { names: ['Zed', 'Yan', 'Xi'], starter: 2 }, game: null };
    await page.addInitScript(v => { try { if (!localStorage.getItem('sevens-out-v1')) localStorage.setItem('sevens-out-v1', v); } catch (e) {} }, JSON.stringify(old));
    await page.goto('/');
    await expect(page.locator('[data-act=play].play')).toBeVisible();
    await page.click('[data-act=play]');
    await page.click('[data-act=players]');
    await expect(page.locator('#name-2')).toHaveValue('Xi');
    await expect(page.locator('#starter-2')).toBeChecked();
    await expect(page.locator('[data-act=play]')).toContainText('Dice in the app');
  });
});

test("Who's playing: the focus moves to the heading after Next", async ({ page }) => {
  await page.goto('/');
  await toPlayers(page);
  await expect(page.locator('#players-h')).toBeFocused();
});
