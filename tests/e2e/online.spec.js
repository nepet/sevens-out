// Online play: separate browser contexts are separate phones. Runs against the Node server,
// or against `wrangler dev` with TARGET=worker (npm run test:worker).
import { test, expect } from '@playwright/test';
import { SERVER, url, live, net, idle, skipRace, enterScore, noSideScroll, openMenu, openSettings, toPlayers, openScores, closeScores, editLine, fakeRoom, seedRandom, chipFits } from './helpers.js';
import '../../engine.js';

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

  test('table sounds: a knock when someone joins, "your turn" only on that phone, and everyone hears the roll', async ({ browser }) => {
    const sounds = page => page.evaluate(() => window.SevensDebug.sounds);
    const A = await host(browser, 'Anna', { reducedMotion: 'reduce' });
    const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
    await expect.poll(() => sounds(A.page)).toEqual(['knock:pub']);
    expect(await sounds(B.page)).toEqual([]);                          // the newcomer hears no knock for themself
    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('[data-act=roll]')).toBeVisible();
    await expect.poll(() => sounds(A.page)).toEqual(['knock:pub', 'yourturn:pub']);
    await A.page.click('[data-act=roll]');
    await expect.poll(() => sounds(B.page)).toEqual(['roll:pub']);   // the watcher hears the throw too
    await A.page.click('[data-act=stop]'); await A.page.click('[data-act=stop]');
    await expect(B.page.locator('[data-act=roll]')).toBeVisible();
    await expect.poll(async () => (await sounds(B.page)).filter(x => x === 'yourturn:pub')).toHaveLength(1);
    expect((await sounds(A.page)).filter(x => x === 'yourturn:pub')).toHaveLength(1);   // not on Anna's phone again
    await A.ctx.close(); await B.ctx.close();
  });

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
    // each phone scatters the dice over its own mat; a remote change (Anna sets a 7-pair aside) doesn't move Ben's dice
    const spotsOf = P => P.page.locator('#app .mat .dice .die[data-id]').evaluateAll(ds => Object.fromEntries(ds.map(d => [d.dataset.id, `${d.style.left} ${d.style.top} ${d.style.getPropertyValue('--rot')}`])));
    const bSpots = await spotsOf(B);
    expect(Object.keys(bSpots)).toHaveLength(6);
    for (const v of Object.values(bSpots)) expect(v).toMatch(/^[\d.]+% [\d.]+% -?[\d.]+deg$/);
    const vals = a1.game.turn.dice.map(d => d.value);
    const pr = [0, 1, 2, 3, 4, 5].flatMap(i => [0, 1, 2, 3, 4, 5].filter(j => j > i && vals[i] + vals[j] === 7).map(j => [i, j]))[0];
    if (pr) {
      await A.page.click(`.dice [data-act=die][data-id="${pr[0]}"]`); await A.page.click(`.dice [data-act=die][data-id="${pr[1]}"]`);
      await expect(B.page.locator('#app .mat .dice .die')).toHaveCount(4);
      const rest = Object.fromEntries(Object.entries(bSpots).filter(([id]) => !pr.includes(+id)));
      expect(await spotsOf(B)).toEqual(rest);
    }

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

  test('a guest who leaves mid-game and joins again with the code gets their seat back and plays', async ({ browser }) => {
    const A = await host(browser, 'Anna', { reducedMotion: 'reduce' });
    const B = await join(browser, A.code, 'Ben', { reducedMotion: 'reduce' });
    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('[data-act=roll]')).toBeVisible();
    const seat = (await net(B.page)).seat;
    await openMenu(B.page);
    await B.page.click('.sheet-layer [data-act=oleave]');
    await B.page.click('.sheet-layer [data-act=oleaveyes]');
    await expect(B.page.locator('#ocode')).toBeVisible();          // back home
    // Anna plays her turn while Ben is away
    await A.page.click('[data-act=roll]');
    await expect.poll(async () => (await live(A.page)).game.turn.rolls).toBe(1);
    await A.page.click('[data-act=stop]'); await A.page.click('[data-act=stop]'); // the starter has rolls left, and nobody sets 7s aside
    await expect(A.page.locator('.turnhead h2.who')).toHaveText('Ben'); // Ben is away, so Anna's phone could cover for him
    // Ben comes back with the code: the same seat, and it's his turn
    await B.page.fill('#ocode', A.code);
    await B.page.click('[data-act=ojoin]');
    await B.page.click('.sheet-layer [data-act=ojoin]');           // the Join sheet keeps the saved name
    await expect(B.page.locator('[data-act=roll]')).toBeVisible();
    expect((await net(B.page)).seat).toBe(seat);
    expect((await net(A.page)).room.seats.map(s => s.name)).toEqual(['Anna', 'Ben']);
    await B.page.click('[data-act=roll]');
    await expect.poll(async () => (await live(A.page)).game.turn.rolls).toBe(1);
    await A.ctx.close(); await B.ctx.close();
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
    await expect(A.page.locator('#app .chiprow [data-act=chat]')).toBeVisible(); // online, connected: the chat button without a dot
    await expect(A.page.locator('#app .chiprow [data-act=chat] .chat-dot')).toHaveCount(0);
    await openScores(A.page);
    await expect(A.page.locator('.pl-away')).toHaveText('Offline');
    await closeScores(A.page);
    await expect(A.page.locator('.keyturn h2.who')).toContainText('Ben');
    await expect(A.page.locator('.mat.keymat .hint')).toHaveText('Ben is offline. As the host you can enter the score for them.');
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
    // the watcher: the chip, the eyebrow and Anna's name, the floor row and the hint row on the mat, the note in the bar
    await expect(B.page.locator('#app > .bar.c4save .waiting')).toBeVisible();
    await expect(B.page.locator('#app > .bar [data-act]')).toHaveCount(0);
    await expect(B.page.locator('.keyturn h2.who')).toContainText('Anna');
    await expect(B.page.locator('.mat.keymat .floor [data-act=drop]')).toBeVisible();
    await expect(B.page.locator('.mat.keymat .hintrow')).toHaveCount(1);
    await expect(B.page.locator('#app .scorechip .sc-p')).toHaveText(['Anna 0', 'Ben 0']);

    for (const ch of '12') await A.page.click(`[data-act=key][data-id="${ch}"]`);
    await A.page.click('[data-act=rolls][data-id="2"]');
    await A.page.click('[data-act=commit]');
    await expect(B.page.locator('.pad')).toBeVisible();
    await expect(B.page.locator('#app .scorechip .sc-p').first()).toHaveText('Anna 12');

    // anyone at the table can report a dropped die; the third one hits whoever is playing (Ben)
    await A.page.click('[data-act=drop]');
    await B.page.click('[data-act=drop]');
    await A.page.click('[data-act=drop]');
    await expect(A.page.locator('.doom')).toBeVisible();
    await expect(B.page.locator('.doom-sub')).toContainText('Ben dropped the third die');
    await A.page.click('.doom-ok'); await B.page.click('.doom-ok');

    // corrections from either phone update both
    await editLine(B.page, 0);
    await B.page.fill('#edit-1', '7');
    await B.page.click('[data-act=esave]');
    await expect(A.page.locator('#app .scorechip .sc-p').first()).toHaveText('Anna 7');
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
  await openScores(B.page);
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
  await editLine(B.page, 0);
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
  expect((await net(p2)).room.settings).toEqual({ kind: 'sevens', mode: 'dice', pairing: 'manual', starter: 0 });
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
  await openSettings(page, 'dev');                                  // the hidden game can't be ended from home's Settings
  await expect(page.locator('.sheet-layer [data-act=devconfetti]')).toBeVisible();
  await expect(page.locator('.sheet-layer [data-act=endearly]')).toHaveCount(0);
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

// eleven guests join over plain WebSockets from one page (same origin as the page, so the Worker's origin check passes),
// the host's phone shows twelve seats, a 13th phone is told the room is full, and twelve can start
test('a room holds twelve: the lobby lists them, the 13th phone is turned away, Start · 12 players', async ({ browser }) => {
  const small = { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, reducedMotion: 'reduce' };
  const A = await host(browser, 'Anna', small);
  const botCtx = await browser.newContext();
  const bots = await botCtx.newPage();
  await bots.goto(url('/'));
  const base = SERVER || (await bots.evaluate(() => location.origin.replace(/^http/, 'ws')));
  const names = ['Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hildegard Wide', 'Ivy', 'Jo', 'Kai', 'Lou'];
  await bots.evaluate(async ([base, code, names]) => {
    window.bots = [];
    for (const name of names) {
      await new Promise((ok, fail) => {
        const ws = new WebSocket(`${base}/room/${code}`);
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name }));
        ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'welcome') ok(); if (m.t === 'error') fail(new Error(m.code)); };
        ws.onerror = () => fail(new Error('socket'));
        window.bots.push(ws);
      });
    }
  }, [base, A.code, names]);
  await expect(A.page.locator('.seat')).toHaveCount(12);
  await expect(A.page.locator('#seats-h')).toHaveText('Players · 12 of 12');
  await expect(A.page.locator('#app > .bar [data-act=ostart]')).toHaveText('Start · 12 players');
  await expect(A.page.locator('#app > .bar [data-act=ostart]')).toBeInViewport();
  expect(await noSideScroll(A.page)).toBe(true);
  // the last seat can be picked to start
  await A.page.click('[data-act=ostarter][data-id="11"]');
  await expect(A.page.locator('[data-act=ostarter][data-id="11"]')).toHaveAttribute('aria-pressed', 'true');

  // a 13th phone: the room is full, and the hint says how many fit
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await page.goto(url(`/?join=${A.code}`));
  await page.fill('.sheet-layer #oname', 'Max');
  await page.click('.sheet-layer [data-act=ojoin]');
  await expect(page.locator('#app')).toContainText(`Room ${A.code} is full. A room holds up to 12 players.`);
  await expect(page.locator('.roomcode')).toHaveCount(0);
  await expect(A.page.locator('.seat')).toHaveCount(12);

  await A.page.click('[data-act=ostart]');
  await expect.poll(async () => ((await live(A.page)).game || {}).players?.length).toBe(12);
  const g = (await live(A.page)).game;
  expect(g.starter).toBe(11);
  await expect(A.page.locator('#app .scorechip .sc-more')).toHaveText('+11 more');
  await expect(A.page.locator('#app .scorechip .sc-p.now')).toHaveText('Lou 0');
  await expect(A.page.locator('#app > .bar .waiting')).toContainText('Waiting for Lou');
  await openScores(A.page);
  await expect(A.page.locator('#app .scores-pop li.pl')).toHaveCount(12);
  expect(await noSideScroll(A.page)).toBe(true);
  await bots.evaluate(() => window.bots.forEach(ws => ws.close()));
  await ctx.close(); await botCtx.close(); await A.ctx.close();
});

// the hand-made rooms (fakeRoom): Anna is seat s1 on this phone, Ben s2, …
const E = globalThis.SevensEngine;
const seatsOf = names => names.map((name, i) => ({ id: `s${i + 1}`, name, connected: true, user: null }));
const roomOf = (names, phase = 'game') => ({ code: 'ABCDE', phase, host: 's1', settings: { mode: 'dice', pairing: 'manual', starter: 0 }, seats: seatsOf(names) });
const msg = (id, text, name = 'Ben', from = 's2') => ({ id, at: Date.now(), from, seat: from, name, user: null, text });
const play = (s, action) => { const r = E.apply(s, action, { rng: () => 3 }); if (r.error) throw new Error(`${action.type}: ${r.error}`); return r; };
const begin = (names, mode = 'dice') => play(E.blank(), { type: 'start', names, seats: names.map((_, i) => `s${i + 1}`), starter: 0, mode, pairing: 'manual' }).state;
const inRoom = page => page.addInitScript(() => localStorage.setItem('sevens-out-online', JSON.stringify({ code: 'ABCDE', token: 't', name: 'Anna', server: '', seen: 0 })));

// ----- table talk: the chat button in the header, and the chat sheet -----
test.describe('chat', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const rm = { reducedMotion: 'reduce' };
  const chatBtn = page => page.locator('#app header [data-act=chat]');
  const chatOf = page => page.evaluate(() => window.SevensDebug.chat);
  async function openChat(page) {
    await chatBtn(page).click();
    await expect(page.locator('#sheet-h')).toHaveText('Chat');
  }
  // type a line in the open chat and press Enter
  async function say(page, text) {
    await page.fill('#chattext', text);
    await page.press('#chattext', 'Enter');
  }
  // the chat log on this phone has n messages (they arrive over the socket)
  const logHas = (page, n) => expect.poll(async () => (await chatOf(page)).log.length).toBe(n);

  test('the chat button: hidden until the server speaks chat, then in the header of the lobby, both turns and game over', async ({ browser }) => {
    const A = await host(browser, 'Anna', rm);
    const B = await join(browser, A.code, 'Ben', rm);
    // the lobby: the last thing in the slim header
    for (const P of [A, B]) {
      await expect(chatBtn(P.page)).toHaveAttribute('aria-label', 'Chat');
      await expect(P.page.locator('#app header.top.slim > :last-child')).toHaveAttribute('data-act', 'chat');
      await expect(P.page.locator('#app [data-act=chat] .chat-badge')).toHaveCount(0);
      expect(await noSideScroll(P.page)).toBe(true);
    }
    // the dice turn: in the chip row, right of the score chip; the chip has no online dot
    const inChipRow = async P => {
      const btn = P.page.locator('#app .chiprow > [data-act=chat]');
      await expect(btn).toBeVisible();
      const [chip, b] = [await P.page.locator('#app .scorechip').boundingBox(), await btn.boundingBox()];
      expect(chip.x + chip.width).toBeLessThanOrEqual(b.x);
      expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44);
      await expect(P.page.locator('.scorechip .sc-dot')).toHaveCount(0);
      await expect(btn.locator('.chat-dot')).toHaveCount(0);     // connected and nothing new: no dot, no badge
      await expect(btn.locator('.chat-badge')).toHaveCount(0);
      expect(await noSideScroll(P.page)).toBe(true);
    };
    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('[data-act=roll]')).toBeVisible();
    for (const P of [A, B]) await inChipRow(P);
    // game over (ended from the menu): the slim header again
    await openMenu(A.page, 'dev');
    await A.page.click('[data-act=endearly]'); await A.page.click('[data-act=endyes]');
    for (const P of [A, B]) {
      await expect(P.page.locator('.verdict')).toBeVisible();
      await expect(P.page.locator('#app header.top.slim > :last-child')).toHaveAttribute('data-act', 'chat');
      expect(await noSideScroll(P.page)).toBe(true);
    }
    // the real-dice turn
    await A.page.click('#app > .bar [data-act=oreopen]');
    await A.page.click('[data-act=omode][data-id="1"]');
    await expect(B.page.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('#app > .bar [data-act=commit]')).toBeVisible();
    for (const P of [A, B]) await inChipRow(P);
    // typing in the chat never reaches the keypad
    const entry = await A.page.locator('.entry').innerText();
    await openChat(A.page);
    await A.page.fill('#chattext', '12');
    await A.page.keyboard.press('Backspace');
    await A.page.keyboard.type('9');
    await expect(A.page.locator('#chattext')).toHaveValue('19');
    await A.page.keyboard.press('Escape');
    await expect(A.page.locator('.sheet-layer')).toBeHidden();
    await expect(A.page.locator('.entry')).toHaveText(entry);
    await A.ctx.close(); await B.ctx.close();
  });

  test('the chat button: no dot while connected with nothing new; unread messages are a green badge with the count; not connected, a red dot', async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben'], 'lobby'), seat: 's1', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    const btn = chatBtn(page);
    await expect(btn).toHaveAttribute('aria-label', 'Chat');
    await expect(btn.locator('.chat-dot')).toHaveCount(0);
    await expect(btn.locator('.chat-badge')).toHaveCount(0);
    fake.push({ t: 'chat', msg: msg(1, 'one') });
    await expect(btn).toHaveAttribute('aria-label', 'Chat, 1 new');
    await expect(btn.locator('.chat-badge')).toHaveText('1');
    await expect(btn.locator('.chat-dot')).toHaveCount(0);
    // green (--ok), its number readable on it (4.5:1) in Pub table light and dark and in Vegas
    const contrast = () => btn.locator('.chat-badge').evaluate(el => {
      const lum = c => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const cs = getComputedStyle(el), ok = getComputedStyle(document.documentElement).getPropertyValue('--ok').trim();
      const probe = document.createElement('i'); probe.style.color = ok; document.body.append(probe);
      const okRgb = getComputedStyle(probe).color; probe.remove();
      const [a, b] = [lum(cs.backgroundColor), lum(cs.color)];
      return { green: cs.backgroundColor === okRgb, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
    for (const [scheme, look] of [['light', 'pub'], ['dark', 'pub'], ['dark', 'vegas']]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(l => { if (l === 'vegas') document.documentElement.dataset.look = 'vegas'; else delete document.documentElement.dataset.look; }, look);
      const c = await contrast();
      expect(c.green, `${scheme} ${look}`).toBe(true);
      expect(c.ratio, `${scheme} ${look}`).toBeGreaterThanOrEqual(4.5);
    }
    for (let i = 2; i <= 10; i++) fake.push({ t: 'chat', msg: msg(i, `m${i}`) });
    await expect(btn.locator('.chat-badge')).toHaveText('9+');
    await expect(btn).toHaveAttribute('aria-label', 'Chat, 10 new');
    // the socket drops: a red dot (and the badge stays) until it is back
    fake.close();
    await expect(btn.locator('.chat-dot')).toBeVisible();
    await expect(btn).toHaveAttribute('aria-label', 'Chat, 10 new, reconnecting');
    expect(await btn.locator('.chat-dot').evaluate(el => { const p = document.createElement('i'); p.style.color = getComputedStyle(el).getPropertyValue('--danger'); document.body.append(p);
      const c = getComputedStyle(p).color; p.remove(); return getComputedStyle(el).backgroundColor === c; })).toBe(true);
    await expect(btn.locator('.chat-badge')).toHaveText('9+');
    await expect.poll(async () => (await net(page)).status).toBe('open');
    await expect(btn.locator('.chat-dot')).toHaveCount(0);
  });

  test('a quick reaction and a typed line reach the other phone; the badge counts and clears', async ({ browser }) => {
    const A = await host(browser, 'Anna', rm);
    const B = await join(browser, A.code, 'Ben', rm);
    await openChat(B.page);
    await expect(B.page.locator('.chat-empty')).toHaveText('Nothing said yet. Say something.');
    await expect(B.page.locator('[data-act=creact]')).toHaveCount(13);
    for (const r of await B.page.locator('[data-act=creact]').all()) {
      const box = await r.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await B.page.click('[data-act=creact][data-id="1"]');
    await expect(chatBtn(A.page)).toHaveAttribute('aria-label', 'Chat, 1 new');
    await expect(A.page.locator('#app [data-act=chat] .chat-badge')).toHaveText('1');
    await say(B.page, 'come on Anna');
    await expect(chatBtn(A.page)).toHaveAttribute('aria-label', 'Chat, 2 new');
    await expect(A.page.locator('#app [data-act=chat] .chat-badge')).toHaveText('2');

    await openChat(A.page);
    const lines = A.page.locator('.chat-log li');
    await expect(lines).toHaveCount(2);
    await expect(lines.first().locator('.chat-text')).toHaveText('🔥');
    await expect(lines.last()).toContainText('Ben');
    await expect(lines.last()).toContainText('come on Anna');
    await expect(A.page.locator('#app [data-act=chat] .chat-badge')).toHaveCount(0);
    await expect(chatBtn(A.page)).toHaveAttribute('aria-label', 'Chat');
    expect((await chatOf(A.page)).unread).toBe(0);
    await expect(A.page.locator('.chat-log .you')).toHaveCount(0);
    // on Ben's phone his own lines say so; the sheet stayed open after both sends, and the field is empty again
    await expect(B.page.locator('.sheet-layer')).toBeVisible();
    await expect(B.page.locator('.chat-log li .you')).toHaveCount(2);
    await expect(B.page.locator('#chattext')).toHaveValue('');
    // a message while the chat is open counts as read
    await say(B.page, 'again');
    await expect(lines).toHaveCount(3);
    expect((await chatOf(A.page)).unread).toBe(0);
    await A.page.keyboard.press('Escape');
    await expect(chatBtn(A.page)).toHaveAttribute('aria-label', 'Chat');
    // an empty line isn't sent
    await B.page.fill('#chattext', '   ');
    await B.page.click('[data-act=csend]');
    await expect(B.page.locator('.sheet-foot .hint')).toHaveText('Type something first.');
    await A.ctx.close(); await B.ctx.close();
  });

  test('hostile text renders literally', async ({ browser }) => {
    const A = await host(browser, 'Anna', rm);
    const B = await join(browser, A.code, 'Ben', rm);
    await openChat(B.page);
    await say(B.page, '<b>x</b><img src=x>');
    await logHas(A.page, 1);
    await openChat(A.page);
    const line = A.page.locator('.chat-log li').last();
    expect(await line.innerText()).toContain('<b>x</b>');
    await expect(line.locator('.chat-text b, .chat-text img, img')).toHaveCount(0);
    await A.ctx.close(); await B.ctx.close();
  });

  test('rejoin keeps seen: a phone that comes back counts only what it missed', async ({ browser }) => {
    const A = await host(browser, 'Anna', rm);
    const B = await join(browser, A.code, 'Ben', rm);
    await openChat(B.page);
    await say(B.page, 'one'); await say(B.page, 'two');
    await expect(chatBtn(A.page)).toHaveAttribute('aria-label', 'Chat, 2 new');
    await openChat(A.page);
    await A.page.keyboard.press('Escape');
    await expect(chatBtn(A.page)).toHaveAttribute('aria-label', 'Chat');
    await A.page.goto('about:blank');
    await say(B.page, 'three');
    await logHas(B.page, 3);
    await A.page.goto(url('/'));                                   // rejoins from sevens-out-online
    await expect(A.page.locator('.roomcode')).toHaveText(A.code);
    await expect(chatBtn(A.page)).toHaveAttribute('aria-label', 'Chat, 1 new');
    const c = await chatOf(A.page);
    expect(c.log).toHaveLength(3);
    expect(new Set(c.log.map(m => m.id)).size).toBe(3);
    await A.ctx.close(); await B.ctx.close();
  });

  test('a newcomer starts at zero', async ({ browser }) => {
    const A = await host(browser, 'Anna', rm);
    const B = await join(browser, A.code, 'Ben', rm);
    await openChat(B.page);
    for (const t of ['one', 'two', 'three']) await say(B.page, t);
    await logHas(A.page, 3);
    const C = await join(browser, A.code, 'Cleo', rm);
    await expect(chatBtn(C.page)).toHaveAttribute('aria-label', 'Chat');
    await expect(C.page.locator('#app [data-act=chat] .chat-badge')).toHaveCount(0);
    expect((await chatOf(C.page)).log.map(m => m.text)).toEqual(['one', 'two', 'three']);
    await A.ctx.close(); await B.ctx.close(); await C.ctx.close();
  });

  test('a spectator chats', async ({ browser }) => {
    const A = await host(browser, 'Anna', rm);
    const B = await join(browser, A.code, 'Ben', rm);
    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('[data-act=roll]')).toBeVisible();
    // Dan opens the invite during the game: he watches
    const ctx = await browser.newContext({ ...phone, ...rm });
    const C = { ctx, page: await ctx.newPage() };
    await C.page.goto(url(`/?join=${A.code}`));
    await C.page.fill('.sheet-layer #oname', 'Dan');
    await C.page.click('.sheet-layer [data-act=ojoin]');
    await expect(C.page.locator('#app .scorechip')).toBeVisible();
    expect((await net(C.page)).seat).toBe(null);
    await openChat(C.page);
    await C.page.click('[data-act=creact][data-id="8"]');          // Haha
    await logHas(A.page, 1);
    await openChat(A.page);
    const line = A.page.locator('.chat-log li').last();
    await expect(line).toContainText(/Dan\s*watching/);
    await expect(line.locator('.chat-text')).toHaveText('Haha');
    await expect(line.locator('.you')).toHaveCount(0);
    await expect(C.page.locator('.chat-log li').last().locator('.you')).toHaveText('you');
    await A.ctx.close(); await B.ctx.close(); await C.ctx.close();
  });

  test('too fast: the ninth message in a row gets the hint, and the phone stays in the room', async ({ browser }) => {
    const A = await host(browser, 'Anna', rm);
    const B = await join(browser, A.code, 'Ben', rm);
    await openChat(B.page);
    for (let i = 0; i < 9; i++) await B.page.click('[data-act=creact][data-id="0"]');
    await expect(B.page.locator('.sheet-foot .hint')).toHaveText('Slow down a little.');
    await logHas(A.page, 8);
    expect((await net(B.page)).code).toBe(A.code);
    await B.page.keyboard.press('Escape');
    await expect(B.page.locator('.roomcode')).toHaveText(A.code);
    await expect(B.page.locator('.sheet-foot .hint')).toHaveCount(0);
    await A.ctx.close(); await B.ctx.close();
  });

  test('a dropped connection: the chat stays open through the reconnect, and the log never doubles', async ({ page }) => {
    const seats = [{ id: 's1', name: 'Anna', connected: true, user: null }, { id: 's2', name: 'Ben', connected: true, user: null }];
    const room = { code: 'ABCDE', phase: 'lobby', host: 's1', settings: { mode: 'dice', pairing: 'manual', starter: 0 }, seats };
    const msg = (id, text) => ({ id, at: Date.now(), from: 's2', seat: 's2', name: 'Ben', user: null, text });
    const fake = await fakeRoom(page, { room, seat: 's1', log: [msg(1, 'one'), msg(2, 'two')] });
    await page.addInitScript(() => localStorage.setItem('sevens-out-online', JSON.stringify({ code: 'ABCDE', token: 't', name: 'Anna', server: '', seen: 0 })));
    await page.goto(url('/'));
    await expect(page.locator('#app [data-act=chat]')).toHaveAttribute('aria-label', 'Chat, 2 new');
    await page.click('#app [data-act=chat]');
    await page.fill('#chattext', 'half a th');
    // watch the button and the sheet on every frame while the socket drops and comes back
    await page.evaluate(() => { window.gone = []; const tick = () => {
      if (!document.querySelector('#app [data-act=chat]')) window.gone.push('button');
      if (document.querySelector('.sheet-layer').hidden) window.gone.push('sheet');
      window.watching = requestAnimationFrame(tick); }; tick(); });
    fake.close();
    await expect.poll(() => fake.hellos()).toBe(2);
    await expect.poll(async () => (await net(page)).status).toBe('open');
    fake.push({ t: 'chat', msg: msg(2, 'two') });                 // a message the log already has
    fake.push({ t: 'chat', msg: msg(3, 'three') });
    await expect(page.locator('.chat-log li')).toHaveCount(3);
    expect(await page.evaluate(() => { cancelAnimationFrame(window.watching); return window.gone; })).toEqual([]);
    await expect(page.locator('#sheet-h')).toHaveText('Chat');
    await expect(page.locator('#chattext')).toHaveValue('half a th');
    expect((await page.evaluate(() => window.SevensDebug.chat)).log.map(m => m.id)).toEqual([1, 2, 3]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#app [data-act=chat]')).toHaveAttribute('aria-label', 'Chat');
  });

  test('typing in the chat: a redraw from another phone keeps the same field, its text, focus and caret', async ({ page }) => {
    const seats = [{ id: 's1', name: 'Anna', connected: true, user: null }, { id: 's2', name: 'Ben', connected: true, user: null }];
    const room = { code: 'ABCDE', phase: 'lobby', host: 's1', settings: { mode: 'dice', pairing: 'manual', starter: 0 }, seats };
    const msg = (id, text) => ({ id, at: Date.now(), from: 's2', seat: 's2', name: 'Ben', user: null, text });
    const fake = await fakeRoom(page, { room, seat: 's1', log: [msg(1, 'one')] });
    await page.addInitScript(() => localStorage.setItem('sevens-out-online', JSON.stringify({ code: 'ABCDE', token: 't', name: 'Anna', server: '' })));
    await page.goto(url('/'));
    await page.click('#app [data-act=chat]');
    await page.fill('#chattext', 'hello world');
    // the caret in the middle of the draft, and the field marked so a rebuilt one would show
    await page.evaluate(() => { const el = document.getElementById('chattext'); el.focus(); el.setSelectionRange(3, 5); el.marked = true; });
    fake.push({ t: 'chat', msg: msg(2, 'two') });
    fake.push({ t: 'room', rev: 2, room: { ...room, seats: [seats[0], { ...seats[1], connected: false }] }, state: null, events: [] });
    await expect(page.locator('.chat-log li')).toHaveCount(2);
    await expect(page.locator('#app .seat .dot.on')).toHaveCount(1);
    expect(await page.evaluate(() => { const el = document.getElementById('chattext');
      return { same: el.marked === true, value: el.value, start: el.selectionStart, end: el.selectionEnd, focused: document.activeElement === el }; }))
      .toEqual({ same: true, value: 'hello world', start: 3, end: 5, focused: true });
    // sending still clears the field, and the hint still updates
    await page.keyboard.press('Enter');
    await expect(page.locator('#chattext')).toHaveValue('');
    await page.keyboard.press('Enter');
    await expect(page.locator('.sheet-foot .hint')).toHaveText('Type something first.');
  });

  test('an old server: no chat button, and the chip keeps its online dot', async ({ page }) => {
    const E = globalThis.SevensEngine;
    const seats = [{ id: 's1', name: 'Anna', connected: true, user: null }, { id: 's2', name: 'Ben', connected: true, user: null }];
    const room = { code: 'ABCDE', phase: 'lobby', host: 's1', settings: { mode: 'dice', pairing: 'manual', starter: 0 }, seats };
    const fake = await fakeRoom(page, { room, seat: 's1', log: null });
    await page.addInitScript(() => localStorage.setItem('sevens-out-online', JSON.stringify({ code: 'ABCDE', token: 't', name: 'Anna', server: '' })));
    await page.goto(url('/'));
    await expect(page.locator('.roomcode')).toHaveText('ABCDE');
    await expect(page.locator('#app [data-act=chat]')).toHaveCount(0);
    const state = E.apply(E.blank(), { type: 'start', names: ['Anna', 'Ben'], seats: ['s1', 's2'], starter: 0, mode: 'dice', pairing: 'manual' }).state;
    fake.push({ t: 'room', rev: 2, room: { ...room, phase: 'game' }, state, events: [] });
    await expect(page.locator('[data-act=roll]')).toBeVisible();
    await expect(page.locator('#app [data-act=chat]')).toHaveCount(0);
    await expect(page.locator('.scorechip .sc-dot')).toHaveCount(1);
    // the same page, once a server speaks chat: the button, and the dot moves onto it
    fake.push({ t: 'chat', log: [] });
    await expect(page.locator('#app .chiprow > [data-act=chat]')).toBeVisible();
    await expect(page.locator('.scorechip .sc-dot')).toHaveCount(0);
  });
});

test.describe('chat feed', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const rm = { reducedMotion: 'reduce' };
  const chatBtn = page => page.locator('#app header [data-act=chat]');
  async function openChat(page) {
    await chatBtn(page).click();
    await expect(page.locator('#sheet-h')).toHaveText('Chat');
  }
  async function say(page, text) {
    await page.fill('#chattext', text);
    await page.press('#chattext', 'Enter');
  }
  const logHas = (page, n) => expect.poll(async () => (await page.evaluate(() => window.SevensDebug.chat)).log.length).toBe(n);
  const lines = page => page.locator('#app .feed .feed-line');
  // every change of the feed on this phone, with the time and whether the page was busy: {lines:[text..], t, busy}
  const watchFeed = page => page.evaluate(() => {
    window.feedSeen = []; let last = null;
    const look = () => {
      const ls = [...document.querySelectorAll('#app .feed-line')].map(el => el.textContent.replace(/\s+/g, ' ').trim()), key = JSON.stringify(ls);
      if (key !== last) { last = key; window.feedSeen.push({ lines: ls, t: performance.now(), busy: window.SevensDebug.busy }); }
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true }); look();
  });
  const seen = page => page.evaluate(() => window.feedSeen);
  // every message that showed, in the order it first showed
  const shown = async page => [...new Set((await seen(page)).flatMap(x => [...x.lines].reverse()))];
  const opacity = loc => loc.evaluate(el => Number(getComputedStyle(el).opacity));
  // the page's clock, installed before goto and paused once the page is up: the feed's time moves only with runFor
  const T0 = new Date('2026-10-21T20:00:00Z').getTime();
  const fakeClock = page => page.clock.install({ time: T0 });
  const pauseClock = page => page.clock.pauseAt(T0 + 60000);
  async function started(browser) {
    const A = await host(browser, 'Anna', rm);
    const B = await join(browser, A.code, 'Ben', rm);
    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('[data-act=roll]')).toBeVisible();
    return { A, B };
  }
  const boxesOf = (page, sels) => page.evaluate(sels => sels.flatMap(sel => [...document.querySelectorAll('#app ' + sel)].map(el => {
    const r = el.getBoundingClientRect(); return [sel, r.x, r.y, r.width, r.height];
  })), sels);

  test('the feed shows another phone\'s message under the name, once, for about 4 s; the eyebrow stays', async ({ browser }) => {
    const { A, B } = await started(browser);
    await watchFeed(A.page);
    await openChat(B.page);
    await say(B.page, 'nice roll');
    const t = lines(A.page);
    await expect(t).toHaveText(['Ben · nice roll']);
    await expect(A.page.locator('#app .turnhead .feed')).toHaveAttribute('aria-hidden', 'true');
    await expect(A.page.locator('#chat-live')).toHaveText('Ben: nice roll');
    // under the name, and the eyebrow keeps showing above it
    const eb = A.page.locator('#app .turnhead .eyebrow');
    await expect(eb).toHaveText('Round 1 · Anna sets the limit');
    expect(await opacity(eb)).toBe(1);
    const [who, line] = [await A.page.locator('#app .turnhead .who').boundingBox(), await t.boundingBox()];
    expect(line.y).toBeGreaterThanOrEqual(who.y + who.height - 0.5);
    await B.page.keyboard.press('Escape');
    await expect(B.page.locator('#app .turnhead .feed')).toHaveCount(1);   // the sender's phone has the area, but
    await expect(lines(B.page)).toHaveCount(0);                            // never its own message
    await expect(t).toHaveCount(0, { timeout: 5000 });
    const log = await seen(A.page), on = log.find(x => x.lines.length), off = log[log.indexOf(on) + 1];
    expect(await shown(A.page)).toEqual(['Ben · nice roll']);
    expect(off.lines).toEqual([]);
    expect(off.t - on.t).toBeGreaterThan(3700);
    expect(off.t - on.t).toBeLessThan(4700);
    await A.ctx.close(); await B.ctx.close();
  });

  test('two at a time: the newest on top at full strength, the one before under it and fainter; each goes 4 s after it came', async ({ page }) => {
    await fakeClock(page);
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben', 'Cleo']), state: begin(['Anna', 'Ben', 'Cleo']), seat: 's1', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('#app > .bar [data-act=roll]')).toBeVisible();
    await pauseClock(page);
    fake.push({ t: 'chat', msg: msg(1, 'first') });
    await expect(lines(page)).toHaveText(['Ben · first']);
    expect(await opacity(lines(page).first())).toBe(1);
    await page.clock.runFor(1000);
    fake.push({ t: 'chat', msg: msg(2, 'second', 'Cleo', 's3') });
    await expect(lines(page)).toHaveText(['Cleo · second', 'Ben · first']);
    await expect(page.locator('#chat-live')).toHaveText('Cleo: second');
    expect(await opacity(lines(page).first())).toBe(1);
    const older = await opacity(lines(page).last());
    expect(older).toBeGreaterThan(0.55);
    expect(older).toBeLessThan(0.75);
    await page.clock.runFor(2990);                                 // 3.99 s after the first: both still there
    await expect(lines(page)).toHaveCount(2);
    await page.clock.runFor(20);                                   // 4.01 s: the first has gone, the second moves up
    await expect(lines(page)).toHaveText(['Cleo · second']);
    expect(await opacity(lines(page).first())).toBe(1);
    await page.clock.runFor(970);                                  // 3.99 s after the second: still there
    await expect(lines(page)).toHaveCount(1);
    await page.clock.runFor(20);                                   // 4.01 s after the second
    await expect(lines(page)).toHaveCount(0);
    await expect(page.locator('#app .turnhead .feed')).toHaveCount(1);   // the area stays, empty
  });

  // the online twin of the chip-fit loop in local.spec.js: the chat button takes 44 px + 8 px of the row
  for (const [w, n] of [[375, 6], [320, 6], [320, 5]]) for (const look of ['pub', 'vegas']) {
    test(`online, ${n} players with 3-digit totals at ${w} px: every name stub and total inside the chip, next to the chat button (${look})`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 667 });
      await page.addInitScript(l => { try { localStorage.setItem('sevens-out-look', l); } catch (e) {} }, look);
      const names = ['Anna', 'Benjamin', 'Cleo', 'Dan', 'Eve', 'Maximilian'].slice(0, n);
      const s = begin(names);
      s.game.players.forEach((p, i) => { p.score = 100 + i; });
      Object.assign(s.game, { ending: true, crosser: n - 1 });
      await fakeRoom(page, { room: roomOf(names), state: s, seat: 's1', log: [] });
      await inRoom(page);
      await page.goto(url('/'));
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.scorechip .sc-p')).toHaveCount(n);
      await expect(page.locator('#app .chatbtn')).toBeVisible();
      await chipFits(page);
      expect(await page.locator('.scorechip .sc-p b').allInnerTexts()).toEqual(['100', '101', '102', '103', '104', '105'].slice(0, n));
      const [chip, btn] = [await page.locator('.scorechip').boundingBox(), await page.locator('#app .chatbtn').boundingBox()];
      expect(chip.x + chip.width, 'chip ends before the chat button').toBeLessThanOrEqual(btn.x + 0.5);
      expect(btn.x).toBeGreaterThanOrEqual(0);
      expect(btn.x + btn.width, 'chat button inside the viewport').toBeLessThanOrEqual(w);
      expect(await noSideScroll(page)).toBe(true);
    });
  }

  for (const look of ['pub', 'vegas']) {
    test(`online, 12 players with long names and 3-digit totals at 320 px: the chip stays on one line next to the chat button (${look})`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 667 });
      await page.addInitScript(l => { try { localStorage.setItem('sevens-out-look', l); } catch (e) {} }, look);
      const names = ['Maximilian Long', 'Bartholomew', 'Cleopatra', 'Dan', 'Eve', 'Frederique', 'Gwendolyn', 'Hieronymus', 'Isadora', 'Jebediah', 'Kristoffer', 'Leopoldine'];
      const s = begin(names);
      s.game.players.forEach((p, i) => { p.score = 100 + i; });
      Object.assign(s.game, { ending: true, crosser: 11 });
      await fakeRoom(page, { room: roomOf(names), state: s, seat: 's1', log: [] });
      await inRoom(page);
      await page.goto(url('/'));
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('#app .chatbtn')).toBeVisible();
      const r = await page.evaluate(() => {
        const c = document.querySelector('.scorechip'), b = document.querySelector('#app .chatbtn').getBoundingClientRect(), cr = c.getBoundingClientRect();
        return { sw: c.scrollWidth, cw: c.clientWidth, h: cr.height, right: cr.right, btn: b.left,
          cut: [...c.querySelectorAll('.sc-p b')].filter(x => x.getBoundingClientRect().right > cr.right + 0.5).length,
          tops: [...new Set([...c.querySelectorAll('.sc-p')].map(x => Math.round(x.getBoundingClientRect().top)))].length };
      });
      expect(r.sw).toBeLessThanOrEqual(r.cw + 0.5);
      expect(r.h).toBeCloseTo(44, 0);
      expect(r.tops).toBe(1);
      expect(r.cut).toBe(0);
      expect(r.right).toBeLessThanOrEqual(r.btn + 0.5);
      expect(await noSideScroll(page)).toBe(true);
    });
  }

  test('a third message pushes the oldest out; the feed shows the newest two', async ({ page }) => {
    await fakeClock(page);
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben'], 'lobby'), seat: 's1', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('.roomcode')).toHaveText('ABCDE');
    await pauseClock(page);
    fake.push({ t: 'chat', msg: msg(1, 'm1') });
    fake.push({ t: 'chat', msg: msg(2, 'm2') });
    await expect(lines(page)).toHaveText(['Ben · m2', 'Ben · m1']);
    await page.clock.runFor(1000);                                 // well inside the first one's 4 s
    fake.push({ t: 'chat', msg: msg(3, 'm3') });
    await expect(lines(page)).toHaveText(['Ben · m3', 'Ben · m2']); // m1 pushed out, not gone by itself
    await expect(page.locator('#chat-live')).toHaveText('Ben: m3');
    expect((await page.evaluate(() => window.SevensDebug.chat)).unread).toBe(3);
    await page.clock.runFor(3010);                                 // m2 goes 4 s after it came; m3 moves up
    await expect(lines(page)).toHaveText(['Ben · m3']);
    await page.clock.runFor(1000);
    await expect(lines(page)).toHaveCount(0);
  });

  test('the feed area: online with chat it is always there, two lines high; one phone and an old server have none', async ({ page, browser }) => {
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben']), state: begin(['Anna', 'Ben']), seat: 's1', log: null });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('#app > .bar [data-act=roll]')).toBeVisible();
    await expect(page.locator('#app .feed')).toHaveCount(0);       // an old server: no chat, no area
    fake.push({ t: 'chat', log: [] });
    const area = page.locator('#app .turnhead .feed');
    await expect(area).toHaveCount(1);
    const empty = await area.boundingBox();
    expect(empty.height).toBeGreaterThanOrEqual(2 * 16 * 1.2);    // room for two lines
    fake.push({ t: 'chat', msg: msg(1, 'one') });
    await expect(lines(page)).toHaveCount(1);
    expect(await area.boundingBox()).toEqual(empty);
    fake.push({ t: 'chat', msg: msg(2, '🔥🔥') });
    await expect(lines(page)).toHaveCount(2);
    expect(await area.boundingBox()).toEqual(empty);
    // one phone: no area
    const ctx = await browser.newContext({ ...phone, ...rm }), local = await ctx.newPage();
    await local.goto(url('/'));
    await local.click('[data-act=play]');
    await local.click('.sheet-layer [data-act=players]');
    await local.click('#app > .bar [data-act=start]');
    await expect(local.locator('#app > .bar [data-act=roll]')).toBeVisible();
    await expect(local.locator('#app .feed')).toHaveCount(0);
    await ctx.close();
  });

  test('sizes: text about 16 px, an emoji in a line about 22 px, a line of only emoji larger (about 30 px); every line inside the area', async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben', 'Cleo']), state: begin(['Anna', 'Ben', 'Cleo']), seat: 's1', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('#app > .bar [data-act=roll]')).toBeVisible();
    const area = page.locator('#app .turnhead .feed'), empty = await area.boundingBox();
    fake.push({ t: 'chat', msg: msg(1, 'Nice one 🔥 <b>x</b>') });
    fake.push({ t: 'chat', msg: msg(2, '🔥👏', 'Cleo', 's3') });
    await expect(lines(page)).toHaveText(['Cleo · 🔥👏', 'Ben · Nice one 🔥 <b>x</b>']);
    await expect(page.locator('#app .feed b b')).toHaveCount(0);   // the text is text
    const size = loc => loc.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    const [big, small] = [lines(page).first().locator('.emo'), lines(page).last().locator('.emo')];
    await expect(big).toHaveCount(2); await expect(small).toHaveCount(1);   // one span per emoji
    const [b, s, text] = [await size(big.first()), await size(small), await size(lines(page).last())];
    expect(text).toBeGreaterThanOrEqual(15); expect(text).toBeLessThanOrEqual(17);
    expect(s).toBeGreaterThanOrEqual(20); expect(s).toBeLessThanOrEqual(24);
    expect(b).toBeGreaterThan(s);
    expect(b).toBeGreaterThanOrEqual(27); expect(b).toBeLessThanOrEqual(32);
    // the area never grows, and the lines and their emoji lie inside it
    expect(await area.boundingBox()).toEqual(empty);
    const out = await page.evaluate(() => {
      const a = document.querySelector('#app .turnhead .feed').getBoundingClientRect();
      return [...document.querySelectorAll('#app .feed-line, #app .feed-line .emo')].filter(el => {
        const r = el.getBoundingClientRect(); return r.top < a.top - 0.5 || r.bottom > a.bottom + 0.5;
      }).map(el => el.className + ' ' + el.textContent);
    });
    expect(out).toEqual([]);
    // the names stay brass and bold
    expect(await lines(page).first().locator('b').evaluate(el => getComputedStyle(el).fontWeight)).toBe('700');
    // emoji the iPhone keyboard sends with VS16 (U+FE0F) count as emoji too: alone, they show large
    fake.push({ t: 'chat', msg: msg(3, '\u26A1\uFE0F') });
    fake.push({ t: 'chat', msg: msg(4, '\u2B50\uFE0F', 'Cleo', 's3') });
    await expect(lines(page)).toHaveText(['Cleo · ⭐️', 'Ben · ⚡️']);
    for (const l of [lines(page).first(), lines(page).last()]) {
      await expect(l.locator('.feed-msg.big .emo')).toHaveCount(1);
      expect(await l.locator('.emo').evaluate(el => el.textContent.length)).toBe(2);   // the VS16 inside the span
      expect(await size(l.locator('.emo'))).toBeGreaterThanOrEqual(27);
    }
    // a long run of emoji: one span each, so the ellipsis cuts the run instead of hiding it whole
    fake.push({ t: 'chat', msg: msg(5, 'Nice ' + '🔥'.repeat(30)) });
    const last = lines(page).first();
    await expect(last.locator('.emo')).toHaveCount(30);
    const cut = await last.locator('.feed-msg').evaluate(m => { const r = m.getBoundingClientRect().right; return [...m.querySelectorAll('.emo')].filter(e => e.getBoundingClientRect().right <= r + 0.5).length; });
    expect(cut).toBeGreaterThanOrEqual(3);                         // the first few show, the rest give way to "…"
    expect(cut).toBeLessThan(30);
    expect(await area.boundingBox()).toEqual(empty);
  });

  // nothing on the turn moves while messages come and go (online, with chat): the dice, the mat, the name, the bar,
  // the keypad and the entry
  for (const vp of [{ width: 375, height: 667 }, { width: 390, height: 844 }]) {
    test(`nothing moves on the dice turn at ${vp.width}×${vp.height}: six players, the 101 alert, two messages come and go`, async ({ page }) => {
      await fakeClock(page);
      await page.setViewportSize(vp);
      await seedRandom(page, vp.width);
      const names = ['Anna', 'Benjamin', 'Cleo', 'Dan', 'Eve', 'Maximilian Long'];
      let s = begin(names);
      s.game.players.forEach((p, i) => { p.score = [88, 104, 95, 100, 79, 99][i]; });
      Object.assign(s.game, { ending: true, crosser: 1 });
      s = play(s, { type: 'roll' }).state;
      const fake = await fakeRoom(page, { room: roomOf(names), state: s, seat: 's1', log: [] });
      await inRoom(page);
      await page.goto(url('/'));
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.turnhead .alert')).toBeVisible();
      await expect(page.locator('#app .mat .dice .die')).toHaveCount(6);
      await pauseClock(page);
      const sels = ['.mat', '.mat .die', '.turnhead .who', '.turnhead .alert', '.turnhead .feed', '> .bar'];
      const before = await boxesOf(page, sels);
      expect(before.filter(b => b[0] === '.mat .die')).toHaveLength(6);
      fake.push({ t: 'chat', msg: msg(1, 'So close! '.repeat(14), 'Benjamin') });
      fake.push({ t: 'chat', msg: msg(2, '🔥', 'Cleo', 's3') });
      await expect(lines(page)).toHaveCount(2);
      expect(await boxesOf(page, sels)).toEqual(before);
      // under the alert, above the mat; a long line is one line, cut with an ellipsis
      const [alert, area, mat] = [await page.locator('.turnhead .alert').boundingBox(), await page.locator('.turnhead .feed').boundingBox(), await page.locator('#app .mat').boundingBox()];
      expect(area.y).toBeGreaterThanOrEqual(alert.y + alert.height - 0.5);
      expect(area.y + area.height).toBeLessThanOrEqual(mat.y + 0.5);
      expect(await lines(page).last().locator('.feed-msg').evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth > el.clientWidth)).toBe(true);
      await page.clock.runFor(4500);
      await expect(lines(page)).toHaveCount(0);
      expect(await boxesOf(page, sels)).toEqual(before);
      // the dice-turn fit, with the feed area: the chip on one line, the dice apart inside the mat, Stop, Roll and the rack on screen
      await chipFits(page);
      const fit = await page.evaluate(() => {
        const box = el => el.getBoundingClientRect(), mat = box(document.querySelector('#app .mat')), hint = box(document.querySelector('#app .mat .hint'));
        const dice = [...document.querySelectorAll('#app .mat .dice .die')].map(box);
        const on = sel => { const r = box(document.querySelector('#app ' + sel)); return r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5; };
        return { die: dice[0].width, inside: dice.every(d => d.left >= mat.left + 8 - 0.5 && d.right <= mat.right - 8 + 0.5 && d.top >= mat.top + 8 - 0.5 && d.bottom <= hint.top + 0.5),
          // two squares that don't overlap have their centres at least a side apart, however they're tilted
          apart: dice.every((d, i) => dice.slice(i + 1).every(e => Math.hypot((d.left + d.right - e.left - e.right) / 2, (d.top + d.bottom - e.top - e.bottom) / 2) >= document.querySelector('#app .mat .die').offsetWidth - 0.5)),
          on: ['> .bar [data-act=stop]', '> .bar [data-act=roll]', '> .bar .rackcell', '.scorechip'].map(on), fits: document.documentElement.scrollHeight <= innerHeight,
          bar: Math.abs(box(document.querySelector('#app > .bar')).bottom - innerHeight) };
      });
      expect(fit.die).toBeGreaterThanOrEqual(48);
      expect(fit.inside).toBe(true);
      expect(fit.apart).toBe(true);
      expect(fit.on).toEqual([true, true, true, true]);
      expect(fit.fits).toBe(true);
      expect(fit.bar).toBeLessThanOrEqual(1);
      expect(await noSideScroll(page)).toBe(true);
    });

    test(`nothing moves on the real-dice turn at ${vp.width}×${vp.height}: two messages come and go`, async ({ page }) => {
      await fakeClock(page);
      await page.setViewportSize(vp);
      const names = ['Anna', 'Ben', 'Cleo'];
      let s = begin(names, 'score');
      s = play(s, { type: 'score', pts: 12, rolls: 2 }).state;     // Ben's turn, with something to undo
      const fake = await fakeRoom(page, { room: { ...roomOf(names), settings: { mode: 'score', pairing: 'manual', starter: 0 } }, state: s, seat: 's2', log: [] });
      await inRoom(page);
      await page.goto(url('/'));
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('#app > .bar [data-act=commit]')).toBeVisible();
      await pauseClock(page);
      const sels = ['.pad', '.entry', '.keymat', '.turnhead .who', '.turnhead .feed', '[data-act=undo]', '> .bar'];
      const before = await boxesOf(page, sels);
      expect(before).toHaveLength(sels.length);
      fake.push({ t: 'chat', msg: msg(1, 'So close! '.repeat(14), 'Anna', 's1') });
      fake.push({ t: 'chat', msg: msg(2, '👏👏', 'Cleo', 's3') });
      await expect(lines(page)).toHaveCount(2);
      expect(await boxesOf(page, sels)).toEqual(before);
      await page.clock.runFor(4500);
      await expect(lines(page)).toHaveCount(0);
      expect(await boxesOf(page, sels)).toEqual(before);
    });
  }

  // a short phone online: the feed area makes the page longer than the screen, so part of the mat lies under the pinned
  // bar; no die lands there
  for (const look of ['pub', 'vegas']) {
    test(`320×568 online, six players and the 101 alert: every die lies above the pinned bar (${look})`, async ({ context }) => {
      const names = ['Anna', 'Benjamin', 'Cleo', 'Dan', 'Eve', 'Maximilian Long'];
      for (const seed of [1, 2, 3, 4, 5]) {
        const page = await context.newPage();
        await page.setViewportSize({ width: 320, height: 568 });
        await page.addInitScript(l => { try { localStorage.setItem('sevens-out-look', l); } catch (e) {} }, look);
        await seedRandom(page, seed);
        let s = begin(names);
        s.game.players.forEach((p, i) => { p.score = [88, 104, 95, 100, 79, 99][i]; });
        Object.assign(s.game, { ending: true, crosser: 1 });
        s = play(s, { type: 'roll' }).state;
        await fakeRoom(page, { room: roomOf(names), state: s, seat: 's1', log: [] });
        await inRoom(page);
        await page.goto(url('/'));
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('#app .turnhead .feed')).toHaveCount(1);
        await expect(page.locator('#app .mat .dice .die')).toHaveCount(6);
        const r = await page.evaluate(() => {
          scrollTo(0, 0);
          const bar = document.querySelector('#app > .bar').getBoundingClientRect(), mat = document.querySelector('#app .mat').getBoundingClientRect();
          return { barTop: bar.top, matBottom: mat.bottom, dice: [...document.querySelectorAll('#app .mat .dice .die')].map(d => { const b = d.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: d.offsetWidth }; }) };
        });
        expect(r.matBottom, 'the mat reaches under the bar here').toBeGreaterThan(r.barTop);
        for (const d of r.dice) {
          expect(d.bottom, `seed ${seed}: a die under the bar`).toBeLessThanOrEqual(r.barTop + 0.5);
          expect(d.w).toBeGreaterThanOrEqual(48);
        }
        // two squares that don't overlap have their centres at least a side apart, however they're tilted
        const c = d => [(d.left + d.right) / 2, (d.top + d.bottom) / 2];
        r.dice.forEach((d, i) => r.dice.slice(i + 1).forEach(e => expect(Math.hypot(c(d)[0] - c(e)[0], c(d)[1] - c(e)[1]), `seed ${seed}: dice apart`).toBeGreaterThanOrEqual(d.w - 0.5)));
        // scrolling never moves them
        const spots = () => page.evaluate(() => [...document.querySelectorAll('#app .mat .dice .die')].map(d => [d.style.left, d.style.top, d.style.getPropertyValue('--rot')]));
        const before = await spots();
        await page.evaluate(() => { scrollTo(0, document.documentElement.scrollHeight); dispatchEvent(new Event('resize')); });
        expect(await spots()).toEqual(before);
        await page.close();
      }
    });
  }

  // CLAUDE.md: "With three players it fits a 390×844 phone without scrolling, Rolls used and Undo included" — online too,
  // with the feed area under the name
  test('the real-dice turn online with three players still fits 390×844 without scrolling, Rolls used and Undo included', async ({ page }) => {
    const names = ['Anna', 'Ben', 'Cleo'];
    let s = begin(names, 'score');
    for (const [pts, rolls] of [[12, 2], [5], [7]]) s = play(s, { type: 'score', pts, ...(rolls ? { rolls } : {}) }).state;
    const starter = s.game.order[s.game.pos];                       // round 2: its starter chooses the rolls used
    const fake = await fakeRoom(page, { room: { ...roomOf(names), settings: { mode: 'score', pairing: 'manual', starter: 0 } }, state: s, seat: `s${starter + 1}`, log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('#app .turnhead .feed')).toHaveCount(1);
    await expect(page.locator('[data-act=rolls]')).toHaveCount(3);
    await expect(page.locator('[data-act=undo]')).toBeVisible();
    fake.push({ t: 'chat', msg: msg(1, 'go go go', names[(starter + 1) % 3], `s${(starter + 1) % 3 + 1}`) });
    await expect(lines(page)).toHaveCount(1);
    const m = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: innerHeight,
      undo: document.querySelector('#app [data-act=undo]').getBoundingClientRect().bottom, bar: document.querySelector('#app > .bar').getBoundingClientRect().top }));
    expect(m.sh).toBeLessThanOrEqual(m.ih);
    expect(m.undo).toBeLessThanOrEqual(m.bar + 0.5);
  });

  test('a message shows once, even when a quick reconnect replays it', async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben'], 'lobby'), seat: 's1', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('.roomcode')).toHaveText('ABCDE');
    // every line the feed reads out (#chat-live is set once per message)
    await page.evaluate(() => { window.said = 0; new MutationObserver(() => window.said++).observe(document.getElementById('chat-live'), { childList: true, characterData: true, subtree: true }); });
    await watchFeed(page);
    const m = msg(1, 'hey');
    fake.push({ t: 'chat', msg: m });
    await expect(lines(page)).toHaveText(['Ben · hey']);
    fake.set({ log: [m] });
    fake.close();                                                  // the socket drops and comes back within 5 s: the log replays it
    await expect.poll(() => fake.hellos()).toBe(2);
    await expect.poll(async () => (await net(page)).status).toBe('open');
    await expect(lines(page)).toHaveCount(0, { timeout: 5000 });
    await page.waitForTimeout(500);
    await expect(lines(page)).toHaveCount(0);
    expect((await seen(page)).filter(x => x.lines.length).every(x => x.lines.length === 1)).toBe(true);
    expect(await page.evaluate(() => window.said)).toBe(1);
    await expect(page.locator('#app [data-act=chat]')).toHaveAttribute('aria-label', 'Chat, 1 new');
  });

  test('the feed on paper screens floats under the header while it has a message (lobby and game over)', async ({ browser }) => {
    const A = await host(browser, 'Anna', rm);
    const B = await join(browser, A.code, 'Ben', rm);
    const under = async n => {
      const box = A.page.locator('#app .feed.under');
      await expect(box).toBeVisible();
      await expect(box.locator('.feed-line')).toHaveCount(n);
      const [tb, hb] = [await box.boundingBox(), await A.page.locator('#app header.top.slim').boundingBox()];
      expect(tb.y).toBeGreaterThanOrEqual(hb.y + hb.height - 0.5);
      expect(await box.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
      expect(await box.evaluate(el => getComputedStyle(el).position)).toBe('absolute');
      expect(await noSideScroll(A.page)).toBe(true);
    };
    await expect(A.page.locator('#app .feed')).toHaveCount(0);     // nothing while there is nothing to say
    await openChat(B.page);
    await say(B.page, 'hi all');
    await expect(lines(A.page)).toHaveText(['Ben · hi all']);
    await under(1);
    await say(B.page, 'ready?');
    await expect(lines(A.page)).toHaveText(['Ben · ready?', 'Ben · hi all']);
    await under(2);
    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('[data-act=roll]')).toBeVisible();
    await openMenu(A.page, 'dev');
    await A.page.click('[data-act=endearly]'); await A.page.click('[data-act=endyes]');
    await expect(A.page.locator('.verdict')).toBeVisible();
    await expect(A.page.locator('#app .feed')).toHaveCount(0, { timeout: 5000 });
    await say(B.page, 'good game');
    await expect(lines(A.page)).toHaveText(['Ben · good game']);
    await under(1);
    await A.ctx.close(); await B.ctx.close();
  });

  test('the feed waits for the race', async ({ browser }) => {
    const { A, B } = await started(browser);
    await watchFeed(A.page);
    await A.page.click('[data-act=roll]');
    await A.page.click('[data-act=stop]'); await A.page.click('[data-act=stop]');
    await expect(B.page.locator('[data-act=roll]')).toBeVisible();
    await B.page.click('[data-act=roll]');
    await B.page.click('[data-act=end]');                          // one roll is Ben's limit: the round ends, the race plays
    await expect(A.page.locator('.race')).toBeVisible();
    await B.page.locator('.race').click();                         // Ben taps his own race away and says something
    await openChat(B.page);
    await say(B.page, 'what a round');
    await logHas(A.page, 1);
    expect(await A.page.evaluate(() => window.SevensDebug.busy)).toBe(true); // it arrived during Anna's race
    await expect(lines(A.page)).toHaveCount(0);
    await idle(A.page);
    await expect(lines(A.page)).toHaveText(['Ben · what a round']);
    expect((await seen(A.page)).filter(x => x.lines.length && x.busy)).toEqual([]);
    await A.ctx.close(); await B.ctx.close();
  });

  test('the feed waits for the race: held over 5 s, it never shows', async ({ page }) => {
    await page.clock.install();
    const names = ['Anna', 'Ben'];
    let s = begin(names);
    s = play(s, { type: 'roll' }).state; s = play(s, { type: 'stop' }).state;   // Anna's turn
    s = play(s, { type: 'roll' }).state;                                          // Ben rolled; his end closes the round
    const end = play(s, { type: 'end' });
    expect(end.events.some(e => e.type === 'roundEnd')).toBe(true);
    const room = roomOf(names);
    const fake = await fakeRoom(page, { room, state: s, seat: 's1', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('#app .scorechip')).toBeVisible();
    await watchFeed(page);
    fake.push({ t: 'room', rev: 2, room, state: end.state, events: end.events });
    await expect(page.locator('.race')).toBeVisible();
    fake.push({ t: 'chat', msg: msg(1, 'too late') });
    await logHas(page, 1);
    expect(await page.evaluate(() => window.SevensDebug.busy)).toBe(true);
    await page.clock.fastForward(6000);                           // the race outlasts the message's 5 s
    await idle(page);
    await expect(page.locator('#app .turnhead .eyebrow')).toHaveText(/^Round 2/);
    expect(await shown(page)).toEqual([]);
    await expect(page.locator('#chat-live')).toHaveText('');
    await expect(chatBtn(page)).toHaveAttribute('aria-label', 'Chat, 1 new'); // still counted on the badge
  });

  test('no feed while the chat is open, and opening it clears the feed', async ({ browser }) => {
    const { A, B } = await started(browser);
    await openChat(B.page);
    await say(B.page, 'before');
    await expect(lines(A.page)).toHaveText(['Ben · before']);
    await watchFeed(A.page);
    await openChat(A.page);
    await expect(lines(A.page)).toHaveCount(0);
    await say(B.page, 'you read this in the log');
    await expect(A.page.locator('.chat-log li')).toHaveCount(2);
    await A.page.keyboard.press('Escape');
    await expect(A.page.locator('.sheet-layer')).toBeHidden();
    await expect(lines(A.page)).toHaveCount(0);
    expect((await seen(A.page)).filter(x => x.lines.length).map(x => x.lines)).toEqual([['Ben · before']]);
    await A.ctx.close(); await B.ctx.close();
  });

  test('your turn closes the chat: Roll gets the focus and the draft is kept', async ({ browser }) => {
    const { A, B } = await started(browser);
    await openChat(B.page);
    await B.page.fill('#chattext', 'draft');
    await A.page.click('[data-act=roll]');
    await A.page.click('[data-act=stop]'); await A.page.click('[data-act=stop]');
    await expect(B.page.locator('.sheet-layer')).toBeHidden();
    await expect(B.page.locator('#app > .bar [data-act=roll]')).toBeFocused();
    await openChat(B.page);
    await expect(B.page.locator('#chattext')).toHaveValue('draft');
    await A.ctx.close(); await B.ctx.close();
  });

  test('reduced motion: the lines appear without animation; otherwise they fade, and a redraw carries the fade on', async ({ page, browser }) => {
    const fakeAt = async p => {
      const fake = await fakeRoom(p, { room: roomOf(['Anna', 'Ben'], 'lobby'), seat: 's1', log: [] });
      await inRoom(p);
      await p.goto(url('/'));
      await expect(p.locator('.roomcode')).toHaveText('ABCDE');
      fake.push({ t: 'chat', msg: msg(1, 'hello') });
      await expect(lines(p)).toHaveCount(1);
      fake.push({ t: 'chat', msg: msg(2, 'again') });
      await expect(lines(p)).toHaveCount(2);
      const names = await p.evaluate(() => [...document.querySelectorAll('#app .feed-line')].flatMap(el => [el, ...el.children]).map(el => getComputedStyle(el).animationName).filter(n => n !== 'none'));
      return { fake, names };
    };
    expect((await fakeAt(page)).names).toEqual([]);
    const ctx = await browser.newContext({ ...phone, reducedMotion: 'no-preference' });
    const p = await ctx.newPage();
    const { fake, names } = await fakeAt(p);
    expect(names).toContain('feed-life');
    // a redraw (the room changes) keeps each line's place in its fade: the delay is negative and grows with its age
    const delays = () => p.evaluate(() => [...document.querySelectorAll('#app .feed-line .feed-msg')].map(el => parseFloat(el.style.animationDelay)));
    const d1 = await delays();
    expect(d1).toHaveLength(2);
    for (const d of d1) expect(d).toBeLessThanOrEqual(0);
    await p.waitForTimeout(300);
    fake.push({ t: 'room', rev: 2, room: { ...roomOf(['Anna', 'Ben'], 'lobby'), settings: { mode: 'score', pairing: 'manual', starter: 0 } }, state: null, events: [] });
    await expect(p.locator('[data-act=omode][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
    const d2 = await delays();
    d2.forEach((d, i) => expect(d).toBeLessThanOrEqual(d1[i] - 250));
    await ctx.close();
  });
});

// chat fixes that need exact messages from the room: a stand-in room (fakeRoom)
test.describe('chat on a stand-in room', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const chatBtn = page => page.locator('#app header [data-act=chat]');
  async function openChat(page) {
    await chatBtn(page).click();
    await expect(page.locator('#sheet-h')).toHaveText('Chat');
  }

  test('Send keeps the text field focused, so the phone keyboard stays up', async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben'], 'lobby'), seat: 's1', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await openChat(page);
    await page.click('#chattext');
    await page.keyboard.type('hello');
    await page.click('[data-act=csend]');
    await expect(page.locator('#chattext')).toHaveValue('');
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('chattext');
    await expect.poll(() => fake.sent().filter(m => m.t === 'chat').map(m => m.text)).toEqual(['hello']);
  });

  test('a late "too fast" with the chat closed leaves the game alone: the dice keep tumbling, the hint stays', async ({ browser }) => {
    const ctx = await browser.newContext({ ...phone, reducedMotion: 'no-preference' }), page = await ctx.newPage();
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben']), state: begin(['Anna', 'Ben']), seat: 's1', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    const hint = page.locator('#app .mat-foot .hint'), roll = page.locator('#app > .bar .rollbtn');
    await expect(roll).toHaveAttribute('data-act', 'roll');
    await roll.click();                                            // the stand-in never answers: the dice tumble on
    await expect(roll).toBeDisabled();
    const said = await hint.innerText();
    fake.push({ t: 'error', code: 'rate', message: 'Slow down a little.' });
    fake.push({ t: 'chat', msg: msg(1, 'after') });                // in order: once this one shows, the error was handled
    await expect(chatBtn(page)).toHaveAttribute('aria-label', 'Chat, 1 new');
    await expect(roll).toBeDisabled();
    await expect(hint).toHaveText(said);
    await expect(page.locator('#app')).not.toContainText('Slow down a little.');
    await ctx.close();
  });

  test('a chat send refused as not_seated (sent before the welcome) answers in the chat, keeps the draft, and never on the game', async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben']), state: begin(['Anna', 'Ben']), seat: 's1', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('#app > .bar [data-act=roll]')).toBeVisible();
    const said = await page.locator('#app .mat-foot .hint').innerText();
    await openChat(page);
    await page.fill('#chattext', 'good luck');
    await page.press('#chattext', 'Enter');
    await expect.poll(() => fake.sent().filter(m => m.t === 'chat').length).toBe(1);
    fake.push({ t: 'error', code: 'not_seated', message: 'Join the room first.' });
    await expect(page.locator('.sheet-foot .hint')).toHaveText('Not in the room yet. Send it again in a moment.');
    await expect(page.locator('#chattext')).toHaveValue('good luck');
    await page.keyboard.press('Escape');
    await expect(page.locator('#app .mat-foot .hint')).toHaveText(said);
    await expect(page.locator('#app')).not.toContainText("You're watching this game");
    // a game move refused the same way still says so on the game
    fake.push({ t: 'error', code: 'not_seated', message: 'Join the room first.' });
    await expect(page.locator('#app .mat-foot .hint')).toHaveText("You're watching this game, so you can't play.");
  });

  test('right-to-left names and text stay in their place: the name and the text are isolated in the log and the feed', async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben']), state: begin(['Anna', 'Ben']), seat: 's1', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('#app > .bar [data-act=roll]')).toBeVisible();
    fake.push({ t: 'chat', msg: { ...msg(1, 'שלום 123'), name: 'דנה', from: 'w1', seat: null } });
    const t = page.locator('#app .turnhead .feed-line');
    await expect(t.locator('bdi')).toHaveText(['דנה', 'שלום 123']);
    await openChat(page);
    const line = page.locator('.chat-log li').last();
    await expect(line.locator('.chat-name bdi, bdi.chat-name')).toHaveText('דנה');
    await expect(line.locator('.chat-text bdi, bdi.chat-text')).toHaveText('שלום 123');
  });

  test('a spectator who reconnects under a new viewer id doesn\'t count their own messages', async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben']), state: begin(['Anna', 'Ben']), seat: null, viewer: 'w1', log: [] });
    await page.addInitScript(() => localStorage.setItem('sevens-out-online', JSON.stringify({ code: 'ABCDE', token: 't', name: 'Dan', server: '', seen: 0 })));
    await page.goto(url('/'));
    await expect(page.locator('#app .scorechip')).toBeVisible();
    await page.evaluate(() => { window.ticked = 0; new MutationObserver(() => { if (document.querySelector('#app .feed-line')) window.ticked++; }).observe(document.body, { childList: true, subtree: true }); });
    await openChat(page);
    await page.fill('#chattext', 'go Anna');
    await page.press('#chattext', 'Enter');
    await expect.poll(() => fake.sent().filter(m => m.t === 'chat').length).toBe(1);
    await page.keyboard.press('Escape');                           // closed before its echo, which the dropped socket loses
    await expect(page.locator('.sheet-layer')).toBeHidden();
    fake.set({ viewer: 'w2', log: [{ id: 1, at: Date.now(), from: 'w1', seat: null, name: 'Dan', user: null, text: 'go Anna' }] });
    fake.close();
    await expect.poll(() => fake.hellos()).toBe(2);
    await expect.poll(async () => (await page.evaluate(() => window.SevensDebug.chat)).log.length).toBe(1);
    await expect(chatBtn(page)).toHaveAttribute('aria-label', 'Chat');
    expect((await page.evaluate(() => window.SevensDebug.chat)).unread).toBe(0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.ticked)).toBe(0);
    await openChat(page);
    await expect(page.locator('.chat-log li').last().locator('.you')).toHaveText('you');
  });
});

test('a room the owner closes from the admin page sends its phones home, and they stay there', async ({ page }) => {
  const fake = await fakeRoom(page, { room: roomOf(['Anna', 'Ben']), state: begin(['Anna', 'Ben']), seat: 's1', log: [] });
  await inRoom(page);
  await page.goto(url('/'));
  await expect(page.locator('[data-act=roll]')).toBeVisible();
  fake.push({ t: 'error', code: 'closed', message: 'This room was closed.' });
  fake.close();
  await expect(page.locator('.home-hint')).toHaveText('Room ABCDE was closed. Create a new room to play on.');
  await expect(page.locator('#ocode')).toHaveValue('');
  expect(await page.evaluate(() => localStorage.getItem('sevens-out-online'))).toBeNull();
  await page.waitForTimeout(1500);
  expect(fake.hellos(), 'no reconnect').toBe(1);
});
