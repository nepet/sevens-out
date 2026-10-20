// Pass-and-play on one phone: both modes, the animations, corrections, the shots alarm and shake to roll.
import { test, expect } from '@playwright/test';
import '../../engine.js';
import { checkReport } from '../../server/core/stats.js';
import { saved, idle, fixDice, startLocal, enterScore, checkSheet, noSideScroll } from './helpers.js';

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
      else if (canRoll) { await page.click('[data-act=stop]'); await page.click('[data-act=stop]'); }
      else await page.click('[data-act=end]');
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
    }
    const s = await saved(page);
    expect(s.phase).toBe('over');
    checkSheet(s.game);
    await page.click('[data-act=undo]');
    expect((await saved(page)).phase).toBe('play');
  });

  test('tie for the lead: whoever reached the score first starts', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 20);
    await enterScore(page, 0, 2); await enterScore(page, 10);       // Ben stays on 20, Anna climbs to 20
    const s = await saved(page);
    expect([s.phase, s.game.round, s.game.starter]).toEqual(['play', 3, 1]); // Ben got there first
  });

  test('corrections recompute totals, the starter and the 101 rule; undo takes them back', async ({ page }) => {
    await startLocal(page, { mode: 'score' });
    await enterScore(page, 10, 1); await enterScore(page, 20);
    await page.click('.pl[data-act=edit][data-id="1"]');
    await page.fill('#edit-1', '40');
    await expect(page.locator('[data-act=esave]')).toBeDisabled();
    await page.fill('#edit-1', '5');
    await expect(page.locator('#edit-total')).toHaveText('5');
    await page.click('[data-act=esave]');
    let s = await saved(page);
    expect(s.game.players.map(p => p.score)).toEqual([10, 5]);
    expect([s.game.round, s.game.starter]).toEqual([2, 0]);          // round 2 starts again, now with Anna
    await enterScore(page, 36, 3); await enterScore(page, 0);
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
});

test('no sideways scrolling at phone width, in both looks', async ({ page }) => {
  await page.goto('/');
  expect(await noSideScroll(page)).toBe(true);
  await page.click('[data-act=look][data-id="1"]');
  await startLocal(page, { names: ['Anna', 'Ben', 'Cleo', 'Dan', 'Eve', 'Finn'] });
  expect(await noSideScroll(page)).toBe(true);
});

test.describe('statistics', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const reports = page => page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-reports') || '{"queue":[],"sent":{}}'));
  async function playShortGame(page) {
    await startLocal(page, { names: ['Anna', 'Ben'], mode: 'score' });
    for (let round = 1; round <= 3; round++) {
      await enterScore(page, 36, 1); // Anna starts every round and reaches 108 in round 3
      await enterScore(page, 5);
    }
    await expect(page.locator('.verdict')).toContainText('loses');
  }

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
