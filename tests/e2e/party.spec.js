// The party look: the owner's switch in the Developer fold, the look on the chosen player's phone, the reveal, and the
// short banner on friends' phones. Three passkey players (owner, chosen, stranger); the switch's rows are written straight
// into the Node server's database (setFlags), so these run against the Node server only, one after another.
import { test, expect } from '@playwright/test';
import { SERVER, url, localUrl, account, addAuthenticator, openProfile, openSettings, openMenu, setFlags, fakeRoom, chipFits, idle, openScores } from './helpers.js';
import '../../engine.js';

const E = globalThis.SevensEngine;

test.skip(!!SERVER, 'writes the flags into the Node server database');
test.describe.configure({ mode: 'serial' });

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
const look = page => page.evaluate(() => document.documentElement.getAttribute('data-look'));

// a phone with a new passkey player, back on home
async function player(browser, name, opts = {}) {
  const ctx = await browser.newContext({ ...phone, ...opts });
  const page = await ctx.newPage();
  await addAuthenticator(page);
  await page.goto(localUrl('/'));
  await openProfile(page);
  await page.fill('#aname', name);
  await page.click('[data-act=acreate]');
  await expect(page.locator('.acct-name')).toContainText(name);
  const id = (await account(page)).id;
  await page.click('[data-act=home]');
  return { ctx, page, id };
}
// a reload re-reads /auth/me, which carries the party
const reread = async page => { await page.reload(); await expect.poll(() => page.evaluate(() => !!window.SevensDebug.account.signedIn)).toBe(true); };

test('the owner sees the switch, a stranger does not', async ({ browser }) => {
  const owner = await player(browser, 'Peter'), stranger = await player(browser, 'Zed'), chosen = await player(browser, 'Aldo');
  await setFlags({ party_owner: owner.id, party_for: chosen.id, party_age: 48, party_on: 0 });
  await reread(owner.page); await reread(stranger.page);

  await openSettings(owner.page, 'dev');
  await expect(owner.page.locator('.sheet-layer [data-act=partyon][role=switch]')).toHaveAttribute('aria-checked', 'false');
  await expect(owner.page.locator('.sheet-layer [data-act=partypreview]')).toBeVisible();
  await expect(owner.page.locator('.sheet-layer [data-act=partyreveal]')).toBeVisible();

  await openSettings(stranger.page, 'dev');
  await expect(stranger.page.locator('.sheet-layer details[data-fold=dev]')).toBeVisible();
  await expect(stranger.page.locator('.sheet-layer [data-act^=party]')).toHaveCount(0);
  expect(await stranger.page.evaluate(() => window.SevensDebug.party)).toBe(null);
  const refused = await stranger.page.evaluate(async () => {
    const a = Object.values(JSON.parse(localStorage.getItem('sevens-out-account')))[0];
    const r = await fetch('/auth/party', { method: 'PUT', headers: { Authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: '{"on":true}' });
    return r.status;
  });
  expect(refused).toBe(404);
  for (const p of [owner, stranger, chosen]) await p.ctx.close();
});

test('preview changes only this phone; a release reaches the chosen phone when it comes back', async ({ browser }) => {
  const owner = await player(browser, 'Peter'), chosen = await player(browser, 'Aldo');
  await chosen.page.evaluate(() => localStorage.setItem('sevens-out-look', 'vegas'));
  await setFlags({ party_owner: owner.id, party_for: chosen.id, party_age: 48, party_on: 0 });
  await reread(owner.page); await reread(chosen.page);
  expect(await look(chosen.page)).toBe('vegas');

  await openSettings(owner.page, 'dev');
  await owner.page.click('.sheet-layer [data-act=partypreview]');
  await expect.poll(() => look(owner.page)).toBe('party');
  expect(await look(chosen.page)).toBe('vegas');
  await owner.page.click('.sheet-layer [data-act=partypreview]');
  await expect.poll(() => look(owner.page)).toBe(null);

  await owner.page.click('.sheet-layer [data-act=partyon]');
  await expect(owner.page.locator('.sheet-layer [data-act=partyon]')).toHaveAttribute('aria-checked', 'true');
  await expect(owner.page.locator('.sheet-layer .party-hint')).toHaveText('Released.');
  // outside a room, the chosen phone asks again when it becomes visible
  await expect.poll(async () => {
    await chosen.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    return look(chosen.page);
  }, { intervals: [500, 1000, 2500] }).toBe('party');
  expect(await chosen.page.evaluate(() => localStorage.getItem('sevens-out-look'))).toBe('vegas');
  for (const p of [owner, chosen]) await p.ctx.close();
});

// ----- a room the test stands in for (fakeRoom): exact party messages, no accounts -----
const seatsOf = names => names.map((name, i) => ({ id: `s${i + 1}`, name, connected: true, user: null }));
const roomOf = (names, phase = 'game') => ({ code: 'ABCDE', phase, host: 's1', settings: { mode: 'dice', pairing: 'manual', starter: 0 }, seats: seatsOf(names) });
const play = (st, action) => { const r = E.apply(st, action, { rng: () => 3 }); if (r.error) throw new Error(`${action.type}: ${r.error}`); return r; };
const begin = (names, starter = 0) => play(E.blank(), { type: 'start', names, seats: names.map((_, i) => `s${i + 1}`), starter, mode: 'dice', pairing: 'manual' }).state;
const ALDO = { t: 'party', seat: 's2', viewer: null, name: 'Aldo', age: 48 };
// every phone in the room plays the reveal when the party starts: close it to go on
const closeReveal = async page => { await expect(page.locator('.party-reveal')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('.party-reveal')).toHaveCount(0); };
const inRoom = page => page.addInitScript(() => localStorage.setItem('sevens-out-online', JSON.stringify({ code: 'ABCDE', token: 't', name: 'Anna', server: '', seen: 0 })));
const box = (page, sel) => page.locator(sel).first().boundingBox();
const meets = (a, b) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe('in a room', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const names = ['Peter', 'Aldo', 'Zed'];

  test("a friend's phone: the balloon by the name and in the reactions, only while the party is on", async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(names), state: begin(names), seat: 's3', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('.scorechip .sc-p')).toHaveCount(3);
    await expect(page.locator('.scorechip')).not.toContainText('\u{1F388}');
    fake.push(ALDO);
    await closeReveal(page);
    await expect(page.locator('.scorechip .sc-p').nth(1)).toContainText('\u{1F388}');
    await expect(page.locator('.scorechip .sc-p').nth(0)).not.toContainText('\u{1F388}');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-look'))).toBe(null);
    await openScores(page);
    await expect(page.locator('.scores-pop li.pl').nth(1).locator('.nm')).toContainText('\u{1F388}');
    await page.keyboard.press('Escape');
    await page.click('#app [data-act=chat]');
    await expect(page.locator('.sheet-layer .reactbtn').first()).toHaveText('\u{1F388}');
    await page.keyboard.press('Escape');
    fake.push({ t: 'party', seat: null, viewer: null });
    await expect(page.locator('.scorechip')).not.toContainText('\u{1F388}');
    await page.click('#app [data-act=chat]');
    await expect(page.locator('.sheet-layer .reactbtn').first()).not.toHaveText('\u{1F388}');
  });

  test("a friend's phone: a short banner over the header when the party player's turn starts, never over the game", async ({ page }) => {
    const r1 = play(begin(names), { type: 'roll' });
    const fake = await fakeRoom(page, { room: roomOf(names), state: r1.state, seat: 's3', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('.scorechip .sc-p')).toHaveCount(3);
    fake.push(ALDO);
    await closeReveal(page);
    await expect(page.locator('.scorechip .sc-p').nth(1)).toContainText('\u{1F388}');
    const r2 = play(r1.state, { type: 'stop' });
    fake.push({ t: 'room', rev: 2, room: roomOf(names), state: r2.state, events: r2.events });
    const banner = page.locator('.party-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('The birthday boy rolls.');
    await expect(banner).toHaveAttribute('aria-hidden', 'true');
    const b = await banner.boundingBox();
    for (const sel of ['#app .mat', '#app .feed', '#app > .bar']) expect(meets(b, await box(page, sel)), `banner clear of ${sel}`).toBe(false);
    expect(b.y + b.height).toBeLessThanOrEqual((await box(page, '#app .turnhead .who')).y + 0.5);
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y).closest('.party-banner'), [b.x + b.width / 2, b.y + b.height / 2]);
    expect(under, 'taps go through').toBe(null);
    await expect.poll(() => banner.count(), { intervals: [100], timeout: 1500 }).toBe(0);
  });

  test("the party player's own phone: no banner, the look, and the reveal after the throw", async ({ page }) => {
    const r1 = play(begin(names), { type: 'roll' });
    const fake = await fakeRoom(page, { room: roomOf(names), state: r1.state, seat: 's2', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('.scorechip .sc-p')).toHaveCount(3);
    fake.push(ALDO);
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-look'))).toBe('party');
    const reveal = page.locator('.party-reveal');
    await expect(reveal).toBeVisible();
    await expect(reveal).toContainText('Happy birthday, mighty Aldo');
    await page.keyboard.press('Escape');
    await expect(reveal).toHaveCount(0);
    await idle(page);
    const r2 = play(r1.state, { type: 'stop' });
    fake.push({ t: 'room', rev: 2, room: roomOf(names), state: r2.state, events: r2.events });
    await expect(page.locator('#app .turnhead .who')).toHaveText(/you/i);
    await page.waitForTimeout(400);
    await expect(page.locator('.party-banner')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.scorechip .sc-p')).toHaveCount(3);
    fake.push(ALDO);
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-look'))).toBe('party');
    await page.waitForTimeout(500);
    await expect(reveal, 'once per release').toHaveCount(0);
  });

  for (const [seat, lk] of [['s1', null], ['s2', 'party']]) {
    test(`six players with 3-digit totals at 375 px: the chip fits with the balloon (${lk || 'pub'} look)`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 667 });
      const six = ['Anna', 'Aldo', 'Cleo', 'Dan', 'Eve', 'Maximilian'];
      const st = begin(six);
      st.game.players.forEach((p, i) => { p.score = 100 + i; });
      const fake = await fakeRoom(page, { room: roomOf(six), state: st, seat, log: [] });
      await inRoom(page);
      await page.goto(url('/'));
      await page.evaluate(() => document.fonts.ready);
      fake.push(ALDO);
      await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-look'))).toBe(lk);
      await closeReveal(page);
      await expect(page.locator('.party-reveal')).toHaveCount(0);
      await chipFits(page);
      const bar = await page.locator('#app > .bar').boundingBox();
      expect(bar.y + bar.height).toBeLessThanOrEqual(667.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
});

test('the reveal waits for a throw that is still playing, and leaves the page idle', async ({ page }) => {
  const names = ['Peter', 'Aldo', 'Zed'], st = begin(names);
  const fake = await fakeRoom(page, { room: roomOf(names), state: st, seat: 's2', log: [] });
  await inRoom(page);
  await page.goto(url('/'));
  await expect(page.locator('.scorechip .sc-p')).toHaveCount(3);
  const r1 = play(st, { type: 'roll' });
  fake.push({ t: 'room', rev: 2, room: roomOf(names), state: r1.state, events: r1.events });
  fake.push(ALDO);
  await expect(page.locator('#app .mat .die.tumble').first()).toBeVisible();
  await expect(page.locator('.party-reveal')).toBeVisible();
  expect(await page.locator('#app .mat .die.tumble').count(), 'the throw has landed').toBe(0);
  await expect(page.locator('#app .mat .die')).toHaveCount(6);
  await page.keyboard.press('Escape');
  await expect(page.locator('.party-reveal')).toHaveCount(0);
  await idle(page);
});

test.describe('the reveal holds', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const names = ['Peter', 'Aldo', 'Zed'];

  test('a reflex tap in the first moments does not close it', async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(names), state: begin(names), seat: 's2', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('.scorechip .sc-p')).toHaveCount(3);
    await page.mouse.click(200, 300); // the phone has been tapped: its audio runs
    fake.push(ALDO);
    const reveal = page.locator('.party-reveal');
    await expect(reveal).toBeVisible();
    for (let i = 0; i < 3; i++) await page.mouse.click(200, 400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await expect(reveal, 'still there').toBeVisible();
    await page.waitForTimeout(1500);
    await page.mouse.click(200, 400); await page.mouse.click(200, 400);
    await expect(reveal).toHaveCount(0);
  });

  test('a hidden page waits: the reveal starts when the phone is looked at', async ({ page }) => {
    await page.addInitScript(() => { window.__vis = 'visible'; Object.defineProperty(document, 'visibilityState', { get: () => window.__vis }); });
    const fake = await fakeRoom(page, { room: roomOf(names), state: begin(names), seat: 's2', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('.scorechip .sc-p')).toHaveCount(3);
    await page.evaluate(() => { window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
    fake.push(ALDO);
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-look'))).toBe('party');
    await page.waitForTimeout(800);
    await expect(page.locator('.party-reveal')).toHaveCount(0);
    await page.evaluate(() => { window.__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.locator('.party-reveal')).toBeVisible();
  });

  test('a slow server does not hold the reveal (or the game) for long', async ({ page }) => {
    // a signed-in phone on localhost whose /auth/me never answers
    await page.addInitScript(() => localStorage.setItem('sevens-out-account', JSON.stringify({ [location.origin]: { token: 'ab'.repeat(32), id: 'c'.repeat(16), name: 'Aldo' } })));
    await page.route('**/auth/me', () => {});
    await page.route('**/auth/config', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    const fake = await fakeRoom(page, { room: roomOf(names), state: begin(names), seat: 's2', log: [] });
    await inRoom(page);
    await page.goto(localUrl('/'));
    await expect(page.locator('.scorechip .sc-p')).toHaveCount(3);
    expect((await account(page)).signedIn).toBe(true);
    fake.push(ALDO);
    await expect(page.locator('.party-reveal')).toBeVisible({ timeout: 4000 });
  });
});

test('the reveal on the chosen phone in a real room: the name and the age, once', async ({ browser }) => {
  const owner = await player(browser, 'Peter', { reducedMotion: 'reduce' }), chosen = await player(browser, 'Aldo', { reducedMotion: 'reduce' });
  await setFlags({ party_owner: owner.id, party_for: chosen.id, party_age: 48, party_on: 0 });
  await reread(owner.page);
  await owner.page.click('[data-act=play]');
  await owner.page.click('[data-act=where][data-id="1"]');
  await owner.page.click('.sheet-layer [data-act=ocreate]');
  const code = await owner.page.locator('.roomcode').innerText();
  await chosen.page.fill('#ocode', code);
  await chosen.page.click('[data-act=ojoin]');
  await expect(chosen.page.locator('.roomcode')).toHaveText(code);

  await openMenu(owner.page, 'dev');
  await owner.page.click('.sheet-layer [data-act=partyon]');
  await expect(owner.page.locator('.sheet-layer .party-hint')).toHaveText('Released.');
  const reveal = chosen.page.locator('.party-reveal');
  await expect(reveal).toBeVisible({ timeout: 4000 });
  await expect(reveal).toContainText('Happy birthday, mighty Aldo');
  await expect(reveal).toContainText('48');
  await chosen.page.keyboard.press('Escape');
  await chosen.page.keyboard.press('Escape');
  await expect(reveal).toHaveCount(0);
  expect(await look(chosen.page)).toBe('party');
  await chosen.page.reload();
  await expect(chosen.page.locator('.roomcode')).toHaveText(code);
  await expect.poll(() => look(chosen.page)).toBe('party');
  await chosen.page.waitForTimeout(500);
  await expect(reveal, 'once per release').toHaveCount(0);
  for (const p of [owner, chosen]) await p.ctx.close();
});

test('withdrawn in a room: the chosen phone gets its own look back; a chosen player who only watches gets the look too', async ({ browser }) => {
  const rm = { reducedMotion: 'reduce' };
  const owner = await player(browser, 'Peter', rm), chosen = await player(browser, 'Aldo', rm), friend = await player(browser, 'Zed', rm);
  await chosen.page.evaluate(() => localStorage.setItem('sevens-out-look', 'vegas'));
  await setFlags({ party_owner: owner.id, party_for: chosen.id, party_age: 48, party_on: 0 });
  await reread(owner.page); await reread(chosen.page);
  await owner.page.click('[data-act=play]');
  await owner.page.click('[data-act=where][data-id="1"]');
  await owner.page.click('.sheet-layer [data-act=ocreate]');
  const code = await owner.page.locator('.roomcode').innerText();
  await friend.page.fill('#ocode', code);
  await friend.page.click('[data-act=ojoin]');
  await expect(owner.page.locator('[data-act=ostart]')).toBeEnabled();
  await owner.page.click('[data-act=ostart]');
  // the chosen player comes in after the start: a spectator
  await chosen.page.fill('#ocode', code);
  await chosen.page.click('[data-act=ojoin]');
  await expect(chosen.page.locator('.scorechip')).toBeVisible();
  expect(await chosen.page.evaluate(() => window.SevensDebug.net.seat)).toBe(null);

  await openMenu(owner.page, 'dev');
  await owner.page.click('.sheet-layer [data-act=partyon]');
  await expect(chosen.page.locator('.party-reveal')).toBeVisible({ timeout: 4000 });
  await chosen.page.keyboard.press('Escape');
  await chosen.page.keyboard.press('Escape');
  await expect(chosen.page.locator('.party-reveal')).toHaveCount(0);
  expect(await look(chosen.page)).toBe('party');
  expect(await look(friend.page), "a friend's phone keeps its look").toBe(null);

  await owner.page.click('.sheet-layer [data-act=partyon]');
  await expect(owner.page.locator('.sheet-layer .party-hint')).toHaveText('Withdrawn.');
  await expect.poll(() => look(chosen.page), { timeout: 4000 }).toBe('vegas');
  expect(await chosen.page.evaluate(() => localStorage.getItem('sevens-out-look'))).toBe('vegas');
  expect(await chosen.page.evaluate(() => localStorage.getItem('sevens-out-party')), 'a new release plays the reveal again').toBe(null);
  for (const p of [owner, chosen, friend]) await p.ctx.close();
});

test.describe('every phone in the room', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });
  const names = ['Peter', 'Aldo', 'Zed'];

  test("a friend's phone plays the reveal too, with the name and the age, once per release, and keeps its own look", async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(names), state: begin(names), seat: 's3', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('.scorechip .sc-p')).toHaveCount(3);
    fake.push(ALDO);
    const reveal = page.locator('.party-reveal');
    await expect(reveal).toBeVisible();
    await expect(reveal).toContainText('Happy birthday, mighty Aldo');
    await expect(reveal).toContainText('48');
    await page.keyboard.press('Escape');
    await expect(reveal).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-look'))).toBe(null);
    await page.reload();
    await expect(page.locator('.scorechip .sc-p')).toHaveCount(3);
    fake.push(ALDO);
    await page.waitForTimeout(600);
    await expect(reveal, 'once per release').toHaveCount(0);
    fake.push({ t: 'party', seat: null, viewer: null, name: null, age: null });
    await expect(page.locator('.scorechip')).not.toContainText('\u{1F388}');
    fake.push(ALDO);
    await expect(reveal, 'a new release plays it again').toBeVisible();
  });

  test('the balloon by the name: the big name on his turn, his messages in the feed and the chat', async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(names), state: begin(names, 1), seat: 's3', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('#app .turnhead .who')).toHaveText('Aldo');
    fake.push(ALDO);
    await closeReveal(page);
    await expect(page.locator('#app .turnhead .who')).toContainText('Aldo\u{1F388}');
    fake.push({ t: 'chat', msg: { id: 1, at: Date.now(), from: 's2', seat: 's2', name: 'Aldo', user: null, text: 'cheers' } });
    await expect(page.locator('#app .feed-line').first()).toContainText('Aldo\u{1F388} · cheers');
    fake.push({ t: 'chat', msg: { id: 2, at: Date.now(), from: 's1', seat: 's1', name: 'Peter', user: null, text: 'hi' } });
    await expect(page.locator('#app .feed-line').first()).toContainText('Peter · hi');
    await page.click('#app [data-act=chat]');
    await expect(page.locator('.sheet-layer .chat-msg').nth(0).locator('.chat-name')).toContainText('Aldo\u{1F388}');
    await expect(page.locator('.sheet-layer .chat-msg').nth(1).locator('.chat-name')).not.toContainText('\u{1F388}');
  });

  test('the balloon by the name in the lobby', async ({ page }) => {
    const fake = await fakeRoom(page, { room: roomOf(names, 'lobby'), seat: 's3', log: [] });
    await inRoom(page);
    await page.goto(url('/'));
    await expect(page.locator('li.seat')).toHaveCount(3);
    fake.push(ALDO);
    await closeReveal(page);
    await expect(page.locator('li.seat').nth(1)).toContainText('Aldo\u{1F388}');
    await expect(page.locator('li.seat').nth(0)).not.toContainText('\u{1F388}');
  });
});
