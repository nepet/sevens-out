// Online play: separate browser contexts are separate phones. Runs against the Node server,
// or against `wrangler dev` with TARGET=worker (npm run test:worker).
import { test, expect } from '@playwright/test';
import { url, live, net, idle, skipRace, enterScore, noSideScroll } from './helpers.js';

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };

async function host(browser, name = 'Anna', opts = {}) {
  const ctx = await browser.newContext({ ...phone, ...opts });
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await page.click('[data-act=online]');
  await page.fill('#oname', name);
  await page.click('[data-act=ocreate]');
  await expect(page.locator('.roomcode')).toHaveText(/^[A-Z2-9]{5}$/);
  return { ctx, page, code: await page.locator('.roomcode').innerText() };
}
async function join(browser, code, name, opts = {}) {
  const ctx = await browser.newContext({ ...phone, ...opts });
  const page = await ctx.newPage();
  await page.goto(url(`/?join=${code}`));
  await expect(page.locator('#ocode')).toHaveValue(code);
  await page.fill('#oname', name);
  await page.click('[data-act=ojoin]');
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
    await expect(B.page.locator('[data-act=opairing][data-id="0"]')).toHaveAttribute('aria-pressed', 'true'); // find the 7s yourself
    await expect(B.page.locator('[data-act=opairing]').first()).toBeDisabled();
    expect(await noSideScroll(A.page)).toBe(true);

    await A.page.click('[data-act=ostart]');
    await expect(A.page.locator('[data-act=roll]')).toBeVisible();
    await expect(B.page.locator('.waiting')).toContainText('Waiting for Anna to roll');
    await expect(B.page.locator('[data-act=roll]')).toHaveCount(0);
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
      const P = (await A.page.locator('.turn .actions [data-act]').count()) ? A : B; // only the player whose turn it is has buttons
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
    await expect(A.page.locator('.pl-away')).toHaveText('Offline');
    await expect(A.page.locator('.hint')).toContainText('Ben is offline');
    await A.page.click('[data-act=roll]');
    await expect.poll(async () => (await live(A.page)).game.turn.rolls).toBe(1);
    await A.ctx.close();
  });
});

test('everyone sees the roll animation and the Sevens Out celebration', async ({ browser }) => {
  const A = await host(browser, 'Anna');
  const B = await join(browser, A.code, 'Ben');
  await A.page.click('[data-act=opairing][data-id="1"]');
  await expect(B.page.locator('[data-act=opairing][data-id="1"]')).toHaveAttribute('aria-pressed', 'true');
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

test('lobby: wrong codes, leaving, kicking and a full room', async ({ browser }) => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await page.click('[data-act=online]');
  await page.fill('#oname', 'Zoe');
  await page.fill('#ocode', 'ZZZZ2');
  await page.click('[data-act=ojoin]');
  await expect(page.locator('.hint')).toContainText("There's no room with the code ZZZZ2");
  await ctx.close();

  const A = await host(browser, 'Anna');
  const B = await join(browser, A.code, 'Ben');
  const C = await join(browser, A.code, 'Cleo');
  await expect(A.page.locator('.seat')).toHaveCount(3);
  await B.page.click('[data-act=oleave]');
  await B.page.click('[data-act=oleaveyes]');
  await expect(B.page.locator('[data-act=online]')).toBeVisible(); // back on the setup screen
  await expect(A.page.locator('.seat')).toHaveCount(2);
  const cleo = (await net(A.page)).room.seats.find(s => s.name === 'Cleo').id;
  await A.page.click(`[data-act=okick][data-seat="${cleo}"]`);
  await expect(C.page.locator('.hint')).toContainText('The host removed you');
  await expect(A.page.locator('.seat')).toHaveCount(1);
  await A.ctx.close(); await B.ctx.close(); await C.ctx.close();
});

test('the pass-and-play game on this phone is kept while playing online', async ({ browser }) => {
  const ctx = await browser.newContext({ ...phone, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(url('/'));
  await page.fill('#name-0', 'Local');
  await page.click('[data-act=start]');
  await page.click('[data-act=new]'); await page.click('[data-act=newyes]');
  await page.click('[data-act=online]');
  await page.fill('#oname', 'Anna');
  await page.click('[data-act=ocreate]');
  await expect(page.locator('.roomcode')).toBeVisible();
  await page.click('[data-act=oleave]'); await page.click('[data-act=oleaveyes]');
  await expect(page.locator('#name-0')).toHaveValue('Local');
  await ctx.close();
});
