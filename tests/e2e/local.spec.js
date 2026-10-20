// Pass-and-play on one phone: both modes, the animations, corrections, the shots alarm and shake to roll.
import { test, expect } from '@playwright/test';
import '../../engine.js';
import { legacyRoundEnd, must } from '../games.js';
import { checkReport } from '../../server/core/stats.js';
import { saved, live, idle, skipRace, fixDice, startLocal, enterScore, checkSheet, noSideScroll } from './helpers.js';

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
    await expect(page.locator('.tval')).toHaveText('10');
  });

  test('by default the player finds the 7s: no help on screen, and a missed pair counts', async ({ page, context }) => {
    await fixDice(context, [1, 6, 2, 5, 3, 3]);
    await startLocal(page);
    await page.click('[data-act=roll]');
    await expect(page.locator('.dice button.die')).toHaveCount(6);
    await expect(page.locator('.rack .pair')).toHaveCount(0);
    await expect(page.locator('.die.can')).toHaveCount(0);           // pairs aren't highlighted
    await expect(page.locator('[data-act=takeall]')).toHaveCount(0);
    await expect(page.locator('.tval')).toHaveText('20');             // everything on the table counts
    await expect(page.locator('.hint')).toContainText('Find the 7s');
    await page.click('.dice [data-act=die][data-id="4"]');             // a 3 can be picked even with no 4 around
    await expect(page.locator('.hint')).toContainText('Now tap a 4');
    await page.click('.dice [data-act=die][data-id="5"]');
    await expect(page.locator('.hint')).toContainText('3 + 3 makes 6, not 7');
    await page.click('.dice [data-act=die][data-id="4"]');             // put the 3 down again
    await page.click('.dice [data-act=die][data-id="1"]');
    await page.click('.dice [data-act=die][data-id="0"]');
    await expect(page.locator('.rack .pair')).toHaveCount(1);
    await expect(page.locator('.tval')).toHaveText('13');
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
    await page.click('[data-fold=dev] summary');
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
    await page.click('.pl[data-act=edit][data-id="1"]');
    await page.fill('#edit-1', '40');
    await expect(page.locator('[data-act=esave]')).toBeDisabled();
    await page.fill('#edit-1', '5');
    await expect(page.locator('#edit-total')).toHaveText('5');
    await page.click('[data-act=esave]');
    let s = await saved(page);
    expect(s.game.players.map(p => p.score)).toEqual([10, 5]);
    expect([s.game.round, s.game.starter]).toEqual([2, 0]);          // round 2 starts again, now with Anna
    await enterScore(page, 36, 3); await enterScore(page, 0); await skipRace(page);
    await page.click('.pl[data-act=edit][data-id="0"]');
    await page.fill('#edit-1', '36');
    await page.click('[data-act=esave]');
    expect((await saved(page)).game.players.map(p => p.score)).toEqual([72, 5]);
    await enterScore(page, 30, 1); await enterScore(page, 0);
    expect((await saved(page)).phase).toBe('over');
    await page.click('.pl[data-act=edit][data-id="0"]');
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
    await expect(page.locator('.pl-shots')).toContainText('Paid 1 round of shots');
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
    await page.click('[data-act=shake][data-id="1"]');
    await startLocal(page);
    await expect(page.locator('.hint')).toContainText('shake the phone');
    const jolt = x => page.evaluate(v => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: v, y: 0, z: 0 } })), x);
    await jolt(25);
    await page.waitForTimeout(1000);
    expect((await saved(page)).game.turn.rolls).toBe(0);
    for (let k = 0; k < 4; k++) { await jolt(k % 2 ? -22 : 22); await page.waitForTimeout(110); }
    await expect.poll(async () => (await saved(page)).game.turn.rolls).toBe(1);
  });

  test('shaking during the race between rounds does not roll', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.click('[data-act=shake][data-id="1"]');
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
    await page.click('[data-act=roll]');
    await page.click('[data-act=stop]'); await page.click('[data-act=stop]');
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
      await page.click(`[data-act=look][data-id="${lookId}"]`);
      await expect(page.locator('.board .pl')).toHaveCount(6);
      const box = await page.locator('.board').boundingBox();
      expect(box.height).toBeLessThanOrEqual(260);
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
    await expect(page.locator('.board .bhead')).toContainText('Round 2 · Ben starts');
    await idle(page);
  });

  test('Escape skips the race too, and a reload during it keeps the last turn', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 20);
    await expect(page.locator('.race')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.race')).toHaveCount(0);
    await expect(page.locator('.board .bhead')).toContainText('Round 2 · Ben starts');
    await enterScore(page, 5, 1); await enterScore(page, 30);       // Anna 40, Ben 25: Anna starts round 3
    await expect(page.locator('.race')).toBeVisible();
    await page.reload();
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
    await page.click('.pl[data-act=edit][data-id="1"]');
    await page.fill('#edit-1', '5');
    await page.click('[data-act=esave]');
    await expect(page.locator('.race')).toHaveCount(0);
    await idle(page);
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
    await page.click('[data-fold=dev] summary');
    const askEnd = async () => {
      await page.click('[data-act=endearly]');
      const text = await page.locator('[data-fold=dev] .confirm span').innerText();
      await page.click('[data-act=endno]');
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
    await page.click('[data-fold=dev] summary');
    await page.click('[data-act=devround]');                    // no round finished yet: made-up points
    await expect(page.locator('.race')).toBeVisible();
    await expect(page.locator('.race-card .pl')).toHaveCount(2);
    await expect(page.locator('.race')).toHaveCount(0);
    await idle(page);
    expect(await saved(page)).toEqual(before);

    await enterScore(page, 20); await skipRace(page);
    before = await saved(page);
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
  window.raceStart = { card: box(c), board: box(document.querySelector('#app .board')), scrollY };
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
  // the list in view at the top; Ben types and saves on the keyboard, so nothing scrolls
  await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
  const board = await page.locator('.board').boundingBox();
  await recordRaceStart(page);
  await trackCurtain(page);
  await page.keyboard.type('20'); await page.keyboard.press('Enter');
  const start = await raceStart(page);
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

test('a score list scrolled away comes back into view, and the race starts from it', async ({ page }) => {
  await startLocal(page, { mode: 'score' });
  await enterScore(page, 10, 1);
  await page.click('[data-act=key][data-id="2"]'); await page.click('[data-act=key][data-id="0"]');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));   // down at the bottom of the page
  const away = await page.locator('.board').boundingBox();
  expect(away.y + away.height).toBeLessThan(0);                                     // the list is off screen
  await recordRaceStart(page);
  await page.click('[data-act=commit]');
  const start = await raceStart(page);
  sameBox(start.card, start.board);                                                 // it starts from the list...
  expect(Math.abs(start.board.y - 16)).toBeLessThanOrEqual(2);                      // ...which is back in view
  await expect(page.locator('.race')).toHaveCount(0, { timeout: 7000 });
  await idle(page);
  await expect(page.locator('.board .bhead')).toContainText('Round 2 · Ben starts');
});

test('no sideways scrolling at phone width, in both looks', async ({ page }) => {
  await page.goto('/');
  expect(await noSideScroll(page)).toBe(true);
  await page.click('[data-act=look][data-id="1"]');
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
  expect(await page.evaluate(() => document.querySelector('style').textContent.includes('color-mix('))).toBe(false);
  const look = () => page.evaluate(() => {
    const now = getComputedStyle(document.querySelector('.board .pl.now'));
    return { fill: now.backgroundColor, ring: now.boxShadow, hatch: getComputedStyle(document.querySelector('.board .trk'), '::after').backgroundImage };
  });
  const pub = await look();
  expect(pub.fill).not.toBe('rgba(0, 0, 0, 0)');
  expect(pub.hatch).toContain('repeating-linear-gradient');
  await page.click('[data-act=look][data-id="1"]');
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
  await expect(page.locator('.board')).toBeVisible();
});
