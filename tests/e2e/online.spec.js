// Online play: separate browser contexts are separate phones. Runs against the Node server,
// or against `wrangler dev` with TARGET=worker (npm run test:worker).
import { test, expect } from '@playwright/test';
import { url, live, net, idle, skipRace, enterScore, noSideScroll, openMenu, openSettings, toPlayers, openScores } from './helpers.js';

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };

// hosting: home → Play sheet → Own phones → the name (a guest without a saved one) → Create room
async function createRoom(page, name) {
  await page.click('[data-act=play]');
  await page.click('[data-act=where][data-id="1"]');
  const field = page.locator('.sheet-layer #oname');
  if (name && await field.count()) await field.fill(name);
  await page.click('.sheet-layer [data-act=ocreate]');
  await expect(page.locator('.roomcode')).toHaveText(/^[A-Z2-9]{5}$/);
}
async function host(browser, name = 'Anna', opts = {}) {
  const ctx = await browser.newContext({ ...phone, ...opts });
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await createRoom(page, name);
  return { ctx, page, code: await page.locator('.roomcode').innerText() };
}
// a guest opens the invite link: home with the code, and the Join sheet asks for the name
async function join(browser, code, name, opts = {}) {
  const ctx = await browser.newContext({ ...phone, ...opts });
  const page = await ctx.newPage();
  await page.goto(url(`/?join=${code}`));
  await expect(page.locator('#ocode')).toHaveValue(code);
  await expect(page.locator('#sheet-h')).toHaveText(`Join room ${code}`);
  await page.fill('.sheet-layer #oname', name);
  await page.click('.sheet-layer [data-act=ojoin]');
  await expect(page.locator('.roomcode')).toHaveText(code);
  return { ctx, page };
}

test.describe('dice in the app', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('two phones: lobby, turns, a spectator view, and rejoining after a reload', async ({ browser }) => {
    const A = await host(browser, 'Anna', { reducedMotion: 'reduce' });
    const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
    await expect(A.page.locator('.seat')).toHaveCount(2);
    await expect(B.page.locator('.waiting')).toContainText('Anna to start');
    await expect(B.page.locator('[data-act=omode]').first()).toBeDisabled();
    await expect(B.page.locator('[data-act=opairing]')).toHaveAttribute('aria-checked', 'false'); // find the 7s yourself
    await expect(B.page.locator('[data-act=opairing]')).toBeDisabled();
    await expect(B.page.locator('[data-act=ostart]')).toHaveCount(0);
    await expect(B.page.locator('#app > .bar .waiting')).toHaveText('Waiting for Anna to start.');
    await expect(A.page.locator('#app > .bar [data-act=ostart]')).toHaveText('Start · 2 players');
    expect(await noSideScroll(A.page)).toBe(true);

    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('[data-act=roll]')).toBeVisible();
    await expect(B.page.locator('.waiting')).toContainText('Waiting for Anna to roll');
    // the pinned bar of the phone whose turn it isn't holds the waiting note instead of the controls
    await expect(B.page.locator('#app > .bar .waiting')).toContainText('Waiting for Anna to roll');
    await expect(B.page.locator('#app > .bar [data-act]')).toHaveCount(0);
    await expect(B.page.locator('[data-act=roll]')).toHaveCount(0);
    // C4: the note takes the place of Stop and Roll; the rack stays, so the pairs fly in on every phone
    await expect(B.page.locator('#app > .bar .rackcell .racklabel')).toHaveText('7s land here');
    const [note, rackCell] = [await B.page.locator('#app > .bar .waiting').boundingBox(), await B.page.locator('#app > .bar .rackcell').boundingBox()];
    expect(note.width).toBeGreaterThan(200);
    expect(note.x + note.width).toBeLessThanOrEqual(rackCell.x);
    // the score chip shows both totals on every phone, this phone's player too
    await expect(B.page.locator('.scorechip .sc-p')).toHaveText(['Anna 0', 'Ben 0']);
    await expect(B.page.locator('.scorechip .sc-p.now')).toHaveText('Anna 0');
    await expect(A.page.locator('.who .you')).toHaveText('you');

    await A.page.click('[data-act=roll]');
    await expect.poll(async () => (await live(B.page)).game.turn.rolls).toBe(1);
    await expect.poll(async () => (await live(A.page)).game.turn.rolls).toBe(1);
    const a1 = await live(A.page), b1 = await live(B.page);
    expect(b1.game.turn.dice).toEqual(a1.game.turn.dice);       // the same roll on both phones
    await expect(B.page.locator('.dice button.die')).toHaveCount(0); // Ben can only watch

    // Anna stops: it's Ben's turn on Ben's phone, with Anna's limit
    const stop = A.page.locator('[data-act=stop], [data-act=end]').first();
    if (await A.page.locator('[data-act=stop]').count()) { await A.page.click('[data-act=stop]'); await A.page.click('[data-act=stop]'); }
    else await stop.click();
    await expect(B.page.locator('[data-act=roll]')).toBeVisible();
    await expect(A.page.locator('.waiting')).toContainText('Waiting for Ben');
    await expect(A.page.locator('#app > .bar .waiting')).toContainText('Waiting for Ben to roll');
    expect((await live(B.page)).game.turn.maxRolls).toBe(1);

    // Ben's phone reloads (screen locked, browser killed...) and gets the same seat back
    await B.page.reload();
    await expect(B.page.locator('[data-act=roll]')).toBeVisible();
    await B.page.click('[data-act=roll]');
    await B.page.click('[data-act=end]');                         // one roll is Ben's limit, so his turn always ends here
    await expect.poll(async () => (await live(A.page)).game.round).toBe(2); // the next round starts by itself
    await expect.poll(async () => (await live(B.page)).game.round).toBe(2);
    expect((await live(A.page)).game).toEqual((await live(B.page)).game);
    await A.ctx.close(); await B.ctx.close();
  });

  test('every phone gets the joke when a player misses a 7-pair', async ({ browser }) => {
    const A = await host(browser, 'Anna', { reducedMotion: 'reduce' });
    const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('[data-act=roll]')).toBeVisible();
    // the server rolls, so keep rolling until a 7-pair turns up, then stop without setting it aside
    const act = async (P, sel) => {
      const rev = (await net(P.page)).rev;
      await P.page.click(sel);
      for (const Q of [A, B]) await expect.poll(async () => (await net(Q.page)).rev).toBeGreaterThan(rev);
    };
    let who = null, pairs = null;
    for (let i = 0; i < 20 && !who; i++) {
      for (const Q of [A, B]) await skipRace(Q.page);
      const P = (await A.page.locator('.bar [data-act]').count()) ? A : B; // only the player whose turn it is has buttons in the bar
      const t = (await live(P.page)).game.turn;
      const found = await P.page.evaluate(() => SevensEngine.matchPairs(SevensDebug.state.game.turn));
      if (!t.rolls) await act(P, '[data-act=roll]');
      else if (found.length) {
        who = P; pairs = found.map(([a, b]) => [t.dice[a].value, t.dice[b].value]);
        if (await P.page.locator('[data-act=stop]').count()) { await P.page.click('[data-act=stop]'); await act(P, '[data-act=stop]'); }
        else await act(P, '[data-act=end]');
      } else if (await P.page.locator('[data-act=roll]').count()) await act(P, '[data-act=roll]');
      else await act(P, '[data-act=end]');
    }
    expect(who).not.toBeNull();
    const other = who === A ? B : A, name = who === A ? 'Anna' : 'Ben';
    const what = pairs.map(([a, b]) => `${a} + ${b}`);
    await expect(who.page.locator('.miss-sub')).toContainText(`You left ${what[0]}`);
    await expect(other.page.locator('.miss-sub')).toContainText(`${name} left ${what[0]}`);
    for (const P of [A, B]) expect(await P.page.locator('.miss-die').evaluateAll(ds => ds.map(d => d.querySelectorAll('.pip').length))).toEqual(pairs[0]);
    await A.ctx.close(); await B.ctx.close();
  });

  test('the host can play for a player who went offline', async ({ browser }) => {
    const A = await host(browser, 'Anna', { reducedMotion: 'reduce' });
    const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
    await A.page.click('[data-act=ostarter][data-id="1"]');
    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('.waiting')).toContainText('Ben to roll');
    await B.ctx.close();
    await openScores(A.page);                                       // the full list, from the score chip
    await expect(A.page.locator('.pl-away')).toHaveText('Offline');
    await expect(A.page.locator('.hint')).toContainText('Ben is offline');
    // the host's bar shows the controls for Ben, not the waiting note
    await expect(A.page.locator('#app > .bar .waiting')).toHaveCount(0);
    await expect(A.page.locator('#app > .bar [data-act=roll].rollbtn')).toHaveText('Roll 6 dice');
    await expect(A.page.locator('#app > .bar .c4left')).toHaveText('Up to 3 rolls');
    await expect(A.page.locator('.turnhead h2.who')).toHaveText('Ben');
    await A.page.click('[data-act=roll]');
    await expect.poll(async () => (await live(A.page)).game.turn.rolls).toBe(1);
    await expect(A.page.locator('#app > .bar [data-act=stop]')).toBeVisible();
    await expect(A.page.locator('#app > .bar [data-act=roll]')).toBeVisible();
    await expect(A.page.locator('#app .dice button.die')).toHaveCount(6);   // the host picks Ben's dice too
    await A.ctx.close();
  });

  test('an open game menu makes way for the race when another phone ends the round', async ({ browser }) => {
    const A = await host(browser, 'Anna', { reducedMotion: 'reduce' });
    const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
    await A.page.click('[data-act=ostart]');
    await A.page.click('[data-act=roll]');
    await A.page.click('[data-act=stop]'); await A.page.click('[data-act=stop]');   // one roll: Ben's limit
    await expect(B.page.locator('[data-act=roll]')).toBeVisible();
    await openMenu(A.page);                                                         // Anna looks at the menu meanwhile
    await B.page.click('[data-act=roll]');
    await B.page.click('[data-act=end]');
    await expect(A.page.locator('.race')).toBeVisible();
    await expect(A.page.locator('.sheet-layer')).toBeHidden();
    await skipRace(A.page);
    expect((await live(A.page)).game.round).toBe(2);
    await A.ctx.close(); await B.ctx.close();
  });
});

test('everyone sees the roll animation and the Sevens Out celebration', async ({ browser }) => {
  const A = await host(browser, 'Anna');
  const B = await join(browser, A.code, 'Ben');
  await A.page.click('[data-act=opairing]');                       // the switch: the app finds the 7s
  await expect(B.page.locator('[data-act=opairing]')).toHaveAttribute('aria-checked', 'true');
  await A.page.click('[data-act=ostart]');
  await A.page.click('[data-act=roll]');
  // Ben's phone tumbles and reveals the same dice, then the pairs fly into the rack
  await expect(B.page.locator('.die.tumble').first()).toBeVisible();
  await idle(B.page);
  const pairs = (await live(B.page)).game.turn.pairs.length;
  await expect(B.page.locator('.rack .pair')).toHaveCount(pairs);
  await A.ctx.close(); await B.ctx.close();
});

test.describe('real dice, scores here', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('the bar: a phone out of turn waits, the host covers an offline player, and game over has Play again', async ({ browser }) => {
    const A = await host(browser, 'Anna', { reducedMotion: 'reduce' });
    const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
    await A.page.click('[data-act=omode][data-id="1"]');
    await expect(B.page.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
    await A.page.click('[data-act=ostart]');
    // Ben's phone: the waiting note sits in the bar, with no keypad and no Save
    await expect(B.page.locator('#app > .bar .waiting')).toContainText('Waiting for Anna to enter their score');
    await expect(B.page.locator('.pad')).toHaveCount(0);
    await expect(B.page.locator('#app > .bar [data-act=commit]')).toHaveCount(0);
    await expect(A.page.locator('#app > .bar [data-act=commit]')).toHaveText('Enter the pips left');
    await enterScore(A.page, 36, 1);
    // Ben goes offline: the host gets the keypad and Save for him
    await expect(B.page.locator('#app > .bar [data-act=commit]')).toBeVisible();
    await B.ctx.close();
    await expect(A.page.locator('.pl-away')).toHaveText('Offline');
    await expect(A.page.locator('.pad')).toBeVisible();
    await expect(A.page.locator('#app > .bar .waiting')).toHaveCount(0);
    await A.page.click('[data-act=key][data-id="5"]');
    await expect(A.page.locator('#app > .bar [data-act=commit]')).toHaveText('Save · Ben +5');
    await A.page.click('[data-act=commit]');
    await skipRace(A.page);
    await A.ctx.close();
  });

  test('game over: the host\'s bar says Play again with this room, a guest waits', async ({ browser }) => {
    const A = await host(browser, 'Anna', { reducedMotion: 'reduce' });
    const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
    await A.page.click('[data-act=omode][data-id="1"]');
    await expect(B.page.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
    await A.page.click('[data-act=ostart]');
    for (let round = 1; round <= 3; round++) {
      await enterScore(A.page, 36, 1);
      await expect(B.page.locator('#app > .bar [data-act=commit]')).toBeVisible();
      await enterScore(B.page, 5);
      if (round < 3) { await skipRace(A.page); await skipRace(B.page); }
    }
    await expect(A.page.locator('.verdict')).toContainText('loses');
    await expect(A.page.locator('#app > .bar [data-act=oreopen]')).toHaveText('Play again with this room');
    await expect(B.page.locator('#app > .bar .waiting')).toContainText('Waiting for Anna to start a new game');
    await expect(B.page.locator('#app > .bar [data-act=oreopen]')).toHaveCount(0);
    await A.ctx.close(); await B.ctx.close();
  });

  test('each player enters their own score; dropped dice and the shots alarm are shared', async ({ browser }) => {
    const A = await host(browser, 'Anna', { reducedMotion: 'reduce' });
    const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
    await A.page.click('[data-act=omode][data-id="1"]');
    await expect(B.page.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
    await A.page.click('[data-act=ostart]');
    await expect(B.page.locator('.waiting')).toContainText('Anna to enter their score');
    await expect(B.page.locator('.pad')).toHaveCount(0);

    for (const ch of '12') await A.page.click(`[data-act=key][data-id="${ch}"]`);
    await A.page.click('[data-act=rolls][data-id="2"]');
    await A.page.click('[data-act=commit]');
    await expect(B.page.locator('.pad')).toBeVisible();
    await expect(B.page.locator('.board .pl').first()).toContainText('12');

    // anyone at the table can report a dropped die; the third one hits whoever is playing (Ben)
    await A.page.click('[data-act=drop]');
    await B.page.click('[data-act=drop]');
    await A.page.click('[data-act=drop]');
    await expect(A.page.locator('.doom')).toBeVisible();
    await expect(B.page.locator('.doom-sub')).toContainText('Ben dropped the third die');
    await A.page.click('.doom-ok'); await B.page.click('.doom-ok');

    // corrections from either phone update both
    await B.page.click('.pl[data-act=edit][data-id="0"]');
    await B.page.fill('#edit-1', '7');
    await B.page.click('[data-act=esave]');
    await expect(A.page.locator('.board .pl').first().locator('.num')).toHaveText('7');
    await A.ctx.close(); await B.ctx.close();
  });
});

test('every phone plays the race, and a phone that reloads during it just shows the new round', async ({ browser }) => {
  const A = await host(browser, 'Anna');
  const B = await join(browser, A.code, 'Ben');
  await A.page.click('[data-act=omode][data-id="1"]');
  await expect(B.page.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
  await A.page.click('[data-act=ostart]');
  await enterScore(A.page, 5, 1);
  await expect(B.page.locator('.pad')).toBeVisible();
  await enterScore(B.page, 20);                                   // Ben leads, so Ben starts round 2
  for (const P of [A, B]) await expect(P.page.locator('.race')).toBeVisible();
  await expect(B.page.locator('.race-starter')).toHaveText('You start');
  await expect(A.page.locator('.race-starter')).toHaveText('Ben starts');
  await expect(A.page.locator('.race-round')).toHaveText('Round 2');

  await B.page.reload();                                          // while Anna's phone still plays the race
  await expect(B.page.locator('.board .bhead')).toContainText('Round 2 · Ben starts');
  await expect(B.page.locator('.race')).toHaveCount(0);
  expect(await B.page.evaluate(() => window.SevensDebug.busy)).toBe(false);
  await expect(B.page.locator('.pad')).toBeVisible();

  await expect(A.page.locator('.race')).toHaveCount(0, { timeout: 7000 });
  await idle(A.page);
  expect((await live(A.page)).game).toEqual((await live(B.page)).game);
  await A.ctx.close(); await B.ctx.close();
});

test('a move made while another phone plays the race shows when that race is over', async ({ browser }) => {
  const A = await host(browser, 'Anna');                                  // normal motion: a 5 s race
  const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
  await A.page.click('[data-act=omode][data-id="1"]');
  await expect(B.page.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
  await A.page.click('[data-act=ostart]');
  await enterScore(A.page, 5, 1);
  await expect(B.page.locator('.pad')).toBeVisible();
  await enterScore(B.page, 20);
  await expect(A.page.locator('.race')).toBeVisible();
  await skipRace(B.page);
  await enterScore(B.page, 10, 2);                                        // Ben starts round 2 right away
  await expect.poll(async () => (await live(B.page)).game.pos).toBe(1);
  const rev = (await net(B.page)).rev;
  await expect.poll(async () => (await net(A.page)).rev).toBe(rev);     // Anna's phone has the move
  await expect(A.page.locator('.race')).toBeVisible();                    // Anna's race isn't cut off
  expect((await live(A.page)).game.round).toBe(1);
  await expect(A.page.locator('.race')).toHaveCount(0, { timeout: 7000 });
  await idle(A.page);
  const g = (await live(A.page)).game;
  expect([g.round, g.rounds[1].results[1].pts, g.order[g.pos]]).toEqual([2, 10, 0]);
  await expect(A.page.locator('.pad')).toBeVisible();                     // Anna's turn
  await A.ctx.close(); await B.ctx.close();
});

test('a correction open on another phone stays open when the round ends', async ({ browser }) => {
  const A = await host(browser, 'Anna', { reducedMotion: 'reduce' });
  const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
  await A.page.click('[data-act=omode][data-id="1"]');
  await expect(B.page.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
  await A.page.click('[data-act=ostart]');
  await enterScore(A.page, 10, 1);
  await expect(B.page.locator('.pad')).toBeVisible();
  await enterScore(B.page, 20);                                   // Ben leads, so Ben starts round 2
  await skipRace(A.page); await skipRace(B.page);
  await enterScore(B.page, 5, 1);
  await expect(A.page.locator('.pad')).toBeVisible();
  // Ben starts correcting Anna's round 1 while Anna enters the last score of round 2
  await B.page.click('.pl[data-act=edit][data-id="0"]');
  await B.page.fill('#edit-1', '12');
  await enterScore(A.page, 8);
  await expect(B.page.locator('.race')).toBeVisible();
  await skipRace(B.page);
  expect((await live(B.page)).game.round).toBe(3);
  await expect(B.page.locator('#edit-h')).toContainText('Anna');
  await expect(B.page.locator('#edit-1')).toHaveValue('12');
  await B.page.click('[data-act=esave]');
  await skipRace(A.page);
  await expect.poll(async () => (await live(A.page)).game.players.map(p => p.score)).toEqual([20, 25]);
  await A.ctx.close(); await B.ctx.close();
});

test('leaving the room before the race keeps the game saved on this phone', async ({ browser }) => {
  const own = { phase: 'setup', setup: { names: ['Zed', 'Yan'], starter: 1, mode: 'score', pairing: 'manual' }, game: null };
  const ctx = await browser.newContext({ ...phone, reducedMotion: 'reduce' });
  await ctx.addInitScript(v => { try { if (!localStorage.getItem('sevens-out-v1')) localStorage.setItem('sevens-out-v1', v); } catch (e) {} }, JSON.stringify(own));
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await expect(page.locator('[data-act=play]')).toBeVisible();      // home, with this phone's own setup kept
  expect((await live(page)).setup.names).toEqual(['Zed', 'Yan']);
  await createRoom(page, 'Anna');                                  // the Play sheet keeps "Own phones" in the setup
  const A = { ctx, page, code: await page.locator('.roomcode').innerText() };
  const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
  await A.page.click('[data-act=omode][data-id="1"]');
  await expect(B.page.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
  await A.page.click('[data-act=ostart]');
  await enterScore(A.page, 5, 1);
  await expect(B.page.locator('.pad')).toBeVisible();
  await enterScore(B.page, 0);                                   // Sevens Out ends round 1: the celebration plays first
  await expect(A.page.locator('.fx-banner')).toBeVisible();
  await openMenu(A.page);
  await A.page.click('[data-act=oleave]');
  await A.page.click('[data-act=oleaveyes]');
  await expect(A.page.locator('[data-act=play]')).toBeVisible();  // back home, with this phone's own setup
  expect((await live(A.page)).setup.names).toEqual(['Zed', 'Yan']);
  await expect.poll(() => A.page.evaluate(() => window.SevensDebug.busy), { timeout: 6000 }).toBe(false);
  await A.page.waitForTimeout(500);
  await expect(A.page.locator('.race')).toHaveCount(0);
  expect((await live(A.page)).phase).toBe('setup');
  await openSettings(A.page);
  await A.page.click('.sheet-layer [data-act=look][data-id="0"]'); // any render saves
  expect(await A.page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-v1')))).toEqual({ ...own, setup: { ...own.setup, where: 'phones' } });
  await skipRace(B.page);
  expect((await live(B.page)).game.round).toBe(2);               // the room goes on without Anna
  await A.ctx.close(); await B.ctx.close();
});

test('lobby: wrong codes, leaving, kicking and a full room', async ({ browser }) => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await page.fill('#ocode', 'ZZZZ2');
  await page.click('[data-act=ojoin]');
  await page.fill('.sheet-layer #oname', 'Zoe');
  await page.click('.sheet-layer [data-act=ojoin]');
  await expect(page.locator('.home-hint')).toContainText("There's no room with the code ZZZZ2"); // back home, the code kept
  await expect(page.locator('#ocode')).toHaveValue('ZZZZ2');
  await expect(page.locator('.sheet-layer')).toBeHidden();
  await ctx.close();

  const A = await host(browser, 'Anna');
  const B = await join(browser, A.code, 'Ben');
  const C = await join(browser, A.code, 'Cleo');
  await expect(A.page.locator('.seat')).toHaveCount(3);
  await openMenu(B.page);
  await B.page.click('[data-act=oleave]');
  await B.page.click('[data-act=oleaveyes]');
  await expect(B.page.locator('.home-head [data-act=settings]')).toBeVisible(); // back home
  await expect(A.page.locator('.seat')).toHaveCount(2);
  const cleo = (await net(A.page)).room.seats.find(s => s.name === 'Cleo').id;
  await A.page.click(`[data-act=okick][data-seat="${cleo}"]`);
  await expect(C.page.locator('.home-hint')).toContainText('The host removed you');
  await expect(C.page.locator('#ocode')).toHaveValue('');
  await expect(A.page.locator('.seat')).toHaveCount(1);
  await A.ctx.close(); await B.ctx.close(); await C.ctx.close();
});

test('the pass-and-play game on this phone is kept while playing online', async ({ browser }) => {
  const ctx = await browser.newContext({ ...phone, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await toPlayers(page);
  await page.fill('#name-0', 'Local');
  await page.click('[data-act=start]');
  await openMenu(page); await page.click('[data-act=new]'); await page.click('[data-act=newyes]');
  await expect(page.locator('#name-0')).toHaveValue('Local');   // New game: Who's playing with the same players
  await page.click('[data-act=home]');
  await createRoom(page, 'Anna');
  await openMenu(page); await page.click('[data-act=oleave]'); await page.click('[data-act=oleaveyes]');
  await expect(page.locator('[data-act=play]')).toBeVisible();
  expect((await live(page)).setup.names[0]).toBe('Local');
  await ctx.close();
});

test('Play sheet, own phones: a guest with no saved name names themselves, then Create room', async ({ browser }) => {
  const ctx = await browser.newContext({ ...phone, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await page.click('[data-act=play]');
  await page.click('[data-act=where][data-id="1"]');
  await expect(page.locator('[data-act=where][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-act=players]')).toHaveCount(0);
  const create = page.locator('.sheet-layer [data-act=ocreate]');
  await expect(create).toHaveText('Create room');
  await create.click();                                            // no name yet
  await expect(page.locator('.sheet-layer .hint')).toContainText('Enter your name first');
  await page.fill('.sheet-layer #oname', 'Nia');
  await page.click('[data-act=mode][data-id="1"]');                // a redraw keeps what was typed
  await expect(page.locator('.sheet-layer #oname')).toHaveValue('Nia');
  await create.click();
  await expect(page.locator('.roomcode')).toHaveText(/^[A-Z2-9]{5}$/);
  await expect(page.locator('.sheet-layer')).toBeHidden();
  expect((await net(page)).room.seats.map(s => s.name)).toEqual(['Nia']);
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-v1')))).setup).toMatchObject({ where: 'phones', mode: 'score' });

  // back home: the name is saved now, so the sheet asks for none
  await openMenu(page); await page.click('[data-act=oleave]'); await page.click('[data-act=oleaveyes]');
  await page.click('[data-act=play]');
  await expect(page.locator('[data-act=where][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sheet-layer #oname')).toHaveCount(0);
  await ctx.close();
});

test('Play sheet, own phones with real dice: the new room is real dice on every phone', async ({ browser }) => {
  const ctx = await browser.newContext({ ...phone, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await page.click('[data-act=play]');
  await page.click('[data-act=where][data-id="1"]');
  await page.click('[data-act=mode][data-id="1"]');                // real dice
  await page.fill('.sheet-layer #oname', 'Nia');
  await page.click('.sheet-layer [data-act=ocreate]');
  await expect(page.locator('.roomcode')).toHaveText(/^[A-Z2-9]{5}$/);
  const A = { ctx, page, code: await page.locator('.roomcode').innerText() };
  await expect(A.page.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
  const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
  await expect(B.page.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(B.page.locator('[data-act=opairing]')).toHaveCount(0);  // no 7s switch with real dice
  expect((await net(B.page)).room.settings).toMatchObject({ mode: 'score', pairing: 'manual' });
  await A.page.click('[data-act=ostart]');
  await expect(A.page.locator('.pad')).toBeVisible();
  await expect.poll(async () => (await live(B.page)).game.mode).toBe('score');
  await A.ctx.close(); await B.ctx.close();
});

test('Play sheet, Create room: the remembered dice and 7s go to the new room; the defaults send nothing', async ({ browser }) => {
  const ctx = await browser.newContext({ ...phone, reducedMotion: 'reduce' });
  const own = { phase: 'setup', setup: { names: ['Zed', 'Yan'], starter: 0, mode: 'dice', pairing: 'auto' }, game: null };
  await ctx.addInitScript(v => { try { if (!localStorage.getItem('sevens-out-v1')) localStorage.setItem('sevens-out-v1', v); } catch (e) {} }, JSON.stringify(own));
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await createRoom(page, 'Anna');
  const A = { ctx, page, code: await page.locator('.roomcode').innerText() };
  const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
  await expect(B.page.locator('[data-act=opairing]')).toHaveAttribute('aria-checked', 'true');
  await expect(B.page.locator('[data-act=omode][data-id="0"]')).toHaveAttribute('aria-pressed', 'true');
  // the host's switch turns it back off for everyone
  await A.page.click('[data-act=opairing]');
  await expect(B.page.locator('[data-act=opairing]')).toHaveAttribute('aria-checked', 'false');
  await A.ctx.close(); await B.ctx.close();

  // a room with the defaults (dice, find the 7s yourself) gets no settings message
  const ctx2 = await browser.newContext(phone);
  await ctx2.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { window.__sent.push(JSON.parse(d)); return send.call(this, d); };
  });
  const p2 = await ctx2.newPage();
  await p2.goto(url('/'));
  await createRoom(p2, 'Cleo');
  await p2.waitForTimeout(300);
  expect(await p2.evaluate(() => window.__sent.filter(m => m.t === 'lobby').length)).toBe(0);
  expect((await net(p2)).room.settings).toEqual({ mode: 'dice', pairing: 'manual', starter: 0 });
  await ctx2.close();
});

test('a ?join link opened by a guest with no saved name: home shows the code, the Join sheet is open with the name focused', async ({ browser }) => {
  const A = await host(browser, 'Anna');
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await page.goto(url(`/?join=${A.code.toLowerCase()}`));
  await expect(page.locator('#app .home-head [data-act=settings]')).toBeAttached(); // home, under the sheet
  await expect(page.locator('#ocode')).toHaveValue(A.code);
  await expect(page.locator('.sheet-layer .sheet')).toBeVisible();
  await expect(page.locator('#sheet-h')).toHaveText(`Join room ${A.code}`);
  const name = page.locator('.sheet-layer #oname');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('');
  await expect(page.locator('.roomcode')).toHaveCount(0);           // no automatic join
  await page.waitForTimeout(300);
  await expect(page.locator('.roomcode')).toHaveCount(0);
  await page.click('.sheet-layer [data-act=ojoin]');                // no name yet
  await expect(page.locator('.sheet-layer .hint')).toContainText('Enter your name first');
  await expect(name).toBeFocused();
  await name.fill('Ben');
  await page.click('.sheet-layer [data-act=ojoin]');
  await expect(page.locator('.roomcode')).toHaveText(A.code);
  await expect(page.locator('.sheet-layer')).toBeHidden();
  await expect(A.page.locator('.seat')).toHaveCount(2);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-name')))).toBe('Ben');
  await ctx.close(); await A.ctx.close();
});

test('Enter in the name field of a ?join landing joins that room, never a new one', async ({ browser }) => {
  const A = await host(browser, 'Anna');
  const ctx = await browser.newContext(phone);
  await ctx.addInitScript(() => {
    window.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { window.__sent.push(JSON.parse(d)); return send.call(this, d); };
  });
  const page = await ctx.newPage();
  await page.goto(url(`/?join=${A.code}`));
  await expect(page.locator('#ocode')).toHaveValue(A.code);
  await expect(page.locator('.sheet-layer #oname')).toBeFocused();
  await page.keyboard.type('Ben');
  await page.keyboard.press('Enter');
  await expect(page.locator('.roomcode')).toHaveText(A.code);
  await expect(A.page.locator('.seat')).toHaveCount(2);
  const hello = await page.evaluate(() => window.__sent.find(m => m.t === 'hello'));
  expect(hello).toMatchObject({ name: 'Ben', create: false });
  expect((await net(page)).code).toBe(A.code);
  await ctx.close(); await A.ctx.close();
});

test('closing the Join sheet clears its hint, so it does not linger under home\'s code row', async ({ browser }) => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await page.goto(url('/?join=K7QPM'));
  await expect(page.locator('.sheet-layer #oname')).toBeFocused();
  await page.click('.sheet-layer [data-act=ojoin]');                // no name yet
  await expect(page.locator('.sheet-layer .hint')).toContainText('Enter your name first');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sheet-layer')).toBeHidden();
  await expect(page.locator('.home-hint')).toHaveText('');
  await page.click('.code-row [data-act=ojoin]');                   // the sheet again, then its close button
  await page.click('.sheet-layer [data-act=ojoin]');
  await expect(page.locator('.sheet-layer .hint')).toContainText('Enter your name first');
  await page.click('.sheet-close');
  await expect(page.locator('.home-hint')).toHaveText('');
  await ctx.close();
});

test('a ?join link over a one-phone game in play: home with the code and the Join sheet; Play goes back to the game', async ({ browser }) => {
  const ctx = await browser.newContext({ ...phone, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await toPlayers(page);
  await page.click('[data-act=start]');
  await expect(page.locator('.bar [data-act=roll]')).toBeVisible();
  const game = (await live(page)).game;
  await page.goto(url('/?join=K7QPM'));
  await expect(page.locator('#ocode')).toHaveValue('K7QPM');
  await expect(page.locator('#sheet-h')).toHaveText('Join room K7QPM');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sheet-layer')).toBeHidden();
  await page.click('[data-act=play]');                              // back to the saved game, as it was
  await expect(page.locator('.bar [data-act=roll]')).toBeVisible();
  expect((await live(page)).game).toEqual(game);
  await ctx.close();
});

test('home Join: a bad or missing code shows the hint and opens no sheet; a guest gets the Join sheet with the saved name', async ({ browser }) => {
  const ctx = await browser.newContext(phone);
  await ctx.addInitScript(() => { try { if (!localStorage.getItem('sevens-out-name')) localStorage.setItem('sevens-out-name', JSON.stringify('Cy')); } catch (e) {} });
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await expect(page.locator('.sheet-layer')).toBeHidden();         // no ?join: no sheet
  await page.click('.code-row [data-act=ojoin]');                   // no code
  await expect(page.locator('.home-hint')).toHaveText('Enter the 5-character room code.');
  await expect(page.locator('.sheet-layer')).toBeHidden();
  await page.fill('#ocode', 'k7q');
  await page.locator('#ocode').press('Enter');                      // Enter in the code field is Join
  await expect(page.locator('.home-hint')).toHaveText('Enter the 5-character room code.');
  await expect(page.locator('.sheet-layer')).toBeHidden();
  await page.fill('#ocode', 'k7qpm');
  await expect(page.locator('#ocode')).toHaveValue('K7QPM');
  await page.locator('#ocode').press('Enter');
  await expect(page.locator('#sheet-h')).toHaveText('Join room K7QPM');
  const name = page.locator('.sheet-layer #oname');
  await expect(name).toHaveValue('Cy');                             // prefilled from the saved name, and focused
  await expect(name).toBeFocused();
  await expect(page.locator('.sheet-layer .hint')).toHaveText('');
  expect(await noSideScroll(page)).toBe(true);
  await page.keyboard.press('Escape');                              // closing it keeps the code, and joins nothing
  await expect(page.locator('.sheet-layer')).toBeHidden();
  await expect(page.locator('#ocode')).toHaveValue('K7QPM');
  await expect(page.locator('.code-row [data-act=ojoin]')).toBeFocused();
  await expect(page.locator('.roomcode')).toHaveCount(0);
  await ctx.close();
});

test('a guest types the code on home: Join opens the sheet, and Join there joins the room', async ({ browser }) => {
  const A = await host(browser, 'Anna');
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await page.fill('#ocode', A.code.toLowerCase());
  await page.click('.code-row [data-act=ojoin]');
  await expect(page.locator('#sheet-h')).toHaveText(`Join room ${A.code}`);
  await expect(page.locator('.roomcode')).toHaveCount(0);
  await page.fill('.sheet-layer #oname', 'Ben');
  await page.click('.sheet-layer [data-act=ojoin]');
  await expect(page.locator('.roomcode')).toHaveText(A.code);
  await expect(A.page.locator('.seat')).toHaveCount(2);
  expect((await net(A.page)).room.seats.map(s => s.name)).toEqual(['Anna', 'Ben']);
  await ctx.close(); await A.ctx.close();
});

test('a focused fold title in the game menu keeps the focus when the room changes', async ({ browser }) => {
  const A = await host(browser, 'Anna');
  await openMenu(A.page, 'rules');
  await A.page.locator('.sheet-layer details[data-fold=rules] summary').focus();
  const B = await join(browser, A.code, 'Ben');
  await expect.poll(async () => (await net(A.page)).room.seats.length).toBe(2);
  await expect(A.page.locator('.sheet-layer details[data-fold=rules] summary')).toBeFocused();
  await B.ctx.close(); await A.ctx.close();
});

test('lobby: the layout, Share invite, and Start pinned for the host', async ({ browser }) => {
  const ctx = await browser.newContext({ ...phone, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true }); });
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await createRoom(page, 'Anna');
  const code = await page.locator('.roomcode').innerText();
  // alone in the room: Start waits for one more player; no tab bar in the lobby
  const start = page.locator('#app > .bar [data-act=ostart]');
  await expect(start).toHaveText('Waiting for one more player');
  await expect(start).toBeDisabled();
  await expect(start).toBeInViewport();
  await expect(page.locator('nav.tabbar')).toHaveCount(0);
  await expect(page.locator('.seat .tag')).toHaveText('Host');
  // the online dot takes its colour from the look's --ok token
  expect(await page.locator('.seat .dot.on').evaluate(el => {
    const probe = document.createElement('i'); probe.style.color = 'var(--ok)'; document.body.append(probe);
    const ok = getComputedStyle(probe).color; probe.remove();
    return getComputedStyle(document.documentElement).getPropertyValue('--ok').trim() !== '' && getComputedStyle(el).backgroundColor === ok;
  })).toBe(true);
  // Share invite without a share sheet copies the link
  await page.click('[data-act=ocopy]');
  await expect(page.locator('.hint')).toHaveText('Link copied. Send it to the others.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`join=${code}`);
  // no clipboard either: the link shows, to copy by hand
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('no')); });
  await page.click('[data-act=ocopy]');
  await expect(page.locator('#olink')).toContainText(`join=${code}`);
  expect(await noSideScroll(page)).toBe(true);
  // Leave room is in the menu
  await openMenu(page);
  await expect(page.locator('.sheet-layer [data-act=oleave]')).toBeVisible();
  // the shown link belongs to that room: leaving and hosting another room starts without it
  await page.click('.sheet-layer [data-act=oleave]');
  await page.click('.sheet-layer [data-act=oleaveyes]');
  await createRoom(page);                                            // the name is saved now: the sheet asks for none
  await expect(page.locator('.roomcode')).not.toHaveText(code);
  await expect(page.locator('.roomcode')).toHaveText(/^[A-Z2-9]{5}$/);
  await expect(page.locator('#olink')).toHaveCount(0);
  await ctx.close();
});

test('lobby on a small phone: Start stays on screen with six players', async ({ browser }) => {
  const small = { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 };
  const A = await host(browser, 'Anna', small);
  const others = [];
  for (const n of ['Ben', 'Cleo', 'Dev', 'Eli', 'Fay']) others.push(await join(browser, A.code, n));
  await expect(A.page.locator('.seat')).toHaveCount(6);
  await expect(A.page.locator('#app > .bar [data-act=ostart]')).toHaveText('Start · 6 players');
  await expect(A.page.locator('#app > .bar [data-act=ostart]')).toBeInViewport();
  expect(await noSideScroll(A.page)).toBe(true);
  for (const o of others) await o.ctx.close();
  await A.ctx.close();
});
