// Playing as your player: online seats carry the player (tags, the seat back from any phone, an ended session),
// and a one-phone game credits the phone owner's line. Runs against the Node server, or `wrangler dev` with TARGET=worker.
import { test, expect } from '@playwright/test';
import { AUTH, localUrl, account, storedAccount, addAuthenticator, copyCredential, net, live, enterScore, skipRace, noSideScroll, openProfile, toPlayers } from './helpers.js';

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' };

// a phone with a passkey authenticator; signed in as `name` when given
async function newPhone(browser, name = null) {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  const auth = await addAuthenticator(page);
  await page.goto(localUrl('/'));
  await openProfile(page);
  if (name) {
    await expect(page.locator('[data-act=acreate]')).toBeVisible();
    await page.fill('#aname', name);
    await page.click('[data-act=acreate]');
    await expect(page.locator('.acct-name')).toContainText(name);
  }
  return { ctx, page, auth, me: name ? await account(page) : null };
}
// open the invite link: a guest names themselves in the Join sheet; a signed-in player taps home's Join and joins at once
async function joinRoom(page, code, guestName = null) {
  await page.goto(localUrl(`/?join=${code}`));
  await expect(page.locator('#ocode')).toHaveValue(code);
  if (guestName) {
    await page.fill('.sheet-layer #oname', guestName);
    await page.click('.sheet-layer [data-act=ojoin]');
  } else {
    await expect(page.locator('.sheet-layer')).toBeHidden();
    await page.click('.code-row [data-act=ojoin]');
    await expect(page.locator('.sheet-layer')).toBeHidden();
  }
}
const tag = p => `#${p.me.id.slice(0, 4)}`;
const seatOf = async (page, name) => (await net(page)).room.seats.find(s => s.name === name);

test('online: players show their tag, take their seat back from another phone, and an ended session plays as a guest', async ({ browser }) => {
  const A = await newPhone(browser, 'Anna');
  await A.page.click('[data-act=home]');
  await expect(A.page.locator('.home-head [data-act=profile]')).toHaveAttribute('aria-label', 'Your player: Anna');
  await A.page.click('[data-act=play]');
  await A.page.click('[data-act=where][data-id="1"]');
  await expect(A.page.locator('.sheet-layer #oname')).toHaveCount(0);  // a player plays under the player name
  await A.page.click('.sheet-layer [data-act=ocreate]');
  await expect(A.page.locator('.roomcode')).toHaveText(/^[A-Z2-9]{5}$/);
  const code = await A.page.locator('.roomcode').innerText();

  const B = await newPhone(browser, 'Ben');
  await joinRoom(B.page, code);
  await expect(B.page.locator('.roomcode')).toHaveText(code);

  // a guest
  const C = await newPhone(browser);
  await joinRoom(C.page, code, 'Cleo');
  await expect(C.page.locator('.roomcode')).toHaveText(code);

  // a session that ended on the server (signed out elsewhere): the phone joins as a guest and drops the account
  const E = await newPhone(browser, 'Eve');
  const dead = (await storedAccount(E.page)).token;
  expect((await E.page.request.post(`${AUTH}/auth/signout`, { headers: { authorization: `Bearer ${dead}` } })).status()).toBe(204);
  await E.page.click('[data-act=home]'); // no reload: the page still holds the session and sends it in hello
  await expect(E.page.locator('.home-head [data-act=profile]')).toContainText('Eve');
  await E.page.fill('#ocode', code);
  await E.page.click('.code-row [data-act=ojoin]');                   // signed in: joins at once, no Join sheet
  await expect(E.page.locator('.roomcode')).toHaveText(code);
  await expect.poll(async () => (await account(E.page)).signedIn).toBe(false);
  expect(await storedAccount(E.page)).toBeNull();

  // the lobby: tags for players, none for guests
  await expect(A.page.locator('.seat')).toHaveCount(4);
  const seats = (await net(A.page)).room.seats;
  expect(seats.map(s => [s.name, s.user])).toEqual([['Anna', A.me.id], ['Ben', B.me.id], ['Cleo', null], ['Eve', null]]);
  await expect(B.page.locator('.seat', { hasText: 'Anna' }).locator('.ptag')).toHaveText(tag(A));
  await expect(A.page.locator('.seat', { hasText: 'Ben' }).locator('.ptag')).toHaveText(tag(B));
  await expect(A.page.locator('.seat', { hasText: 'Cleo' }).locator('.ptag')).toHaveCount(0);
  await expect(A.page.locator('.seat', { hasText: 'Eve' }).locator('.ptag')).toHaveCount(0);
  expect(await noSideScroll(A.page)).toBe(true);

  // the game: the score list shows the others' tags (this phone's own line says "you")
  await A.page.click('[data-act=ostart]');
  await expect(A.page.locator('.board')).toBeVisible();
  await expect(A.page.locator('.board .pl', { hasText: 'Ben' }).locator('.ptag')).toHaveText(tag(B));
  await expect(A.page.locator('.board .pl', { hasText: 'Anna' }).locator('.ptag')).toHaveCount(0);
  await expect(A.page.locator('.board .pl', { hasText: 'Cleo' }).locator('.ptag')).toHaveCount(0);
  await expect(C.page.locator('.board .pl', { hasText: 'Anna' }).locator('.ptag')).toHaveText(tag(A));

  // Anna's passkey on another phone, without the room's token: she gets her seat back mid-game and plays her turn
  const D = await newPhone(browser);
  await copyCredential(A.auth, D.auth);
  await D.page.click('[data-act=asignin]');
  await expect(D.page.locator('.acct-name')).toContainText('Anna');
  await joinRoom(D.page, code);
  await expect(D.page.locator('.board')).toBeVisible();
  expect((await net(D.page)).seat).toBe((await seatOf(A.page, 'Anna')).id);
  const st = await live(D.page);
  expect(st.game.seats[st.game.order[st.game.pos]]).toBe((await net(D.page)).seat); // Anna starts
  await D.page.click('[data-act=roll]');
  await expect.poll(async () => (await live(A.page)).game.turn.rolls).toBe(1);
  await expect(D.page.locator('.board .pl', { hasText: 'Anna' }).locator('.you')).toBeVisible();

  for (const p of [A, B, C, D, E]) await p.ctx.close();
});

test('one phone: the signed-in player\'s line says "You", "This is me" moves it, and the report credits it', async ({ browser }) => {
  const P = await newPhone(browser, 'Anna');
  const { page } = P;
  const token = (await storedAccount(page)).token;
  const sent = [];
  await page.route('**/report', async route => {
    sent.push({ body: route.request().postDataJSON(), auth: await route.request().headerValue('authorization') });
    await route.fulfill({ status: 204 });
  });

  // Who's playing, real dice: no line is Anna yet, so every line offers "This is me"
  await page.click('[data-act=home]');
  await toPlayers(page, { mode: 'score' });
  await expect(page.locator('.me-link')).toHaveCount(2);
  await page.fill('#name-0', ' anna ');
  await expect(page.locator('[data-me="0"] .me-you')).toHaveText('You');
  await expect(page.locator('[data-me="1"] .me-link')).toBeVisible();
  await page.fill('#name-1', 'Ben');
  await page.getByRole('button', { name: 'This is me, line 2' }).click();
  await expect(page.locator('#name-1')).toHaveValue('Anna');
  await expect(page.locator('#name-0')).toHaveValue('Ben'); // swapped
  await expect(page.locator('[data-me="1"] .me-you')).toHaveText('You');
  expect(await noSideScroll(page)).toBe(true);

  // a short real-dice game: Ben starts and loses
  await page.click('[data-act=start]');
  expect((await live(page)).stats.owner).toBe(1);
  for (let round = 1; round <= 3; round++) {
    await enterScore(page, 36, 1);
    await enterScore(page, 5);
    if (round < 3) await skipRace(page);
  }
  await expect(page.locator('.verdict')).toContainText('loses');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].body.owner).toBe(1);
  expect(sent[0].body.sheet.players).toEqual(['Ben', 'Anna']);
  expect(sent[0].auth).toBe(`Bearer ${token}`);

  // signed out: no line is "you", and a new game has no owner
  await page.click('[data-act=again]');
  await expect(page.locator('[data-me]')).toHaveCount(2);           // Play again: Who's playing, still signed in
  await page.click('[data-act=home]');
  await openProfile(page);
  await page.click('[data-act=asignout]');
  await page.click('[data-act=home]');
  await toPlayers(page, { mode: 'score' });
  await expect(page.locator('#name-1')).toHaveValue('Anna');
  await expect(page.locator('[data-me]')).toHaveCount(0);
  await P.ctx.close();
});

test('a waiting report goes out with its owner\'s session only', async ({ browser }) => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await addAuthenticator(page);
  await page.route('**/report', route => route.abort('internetdisconnected'));
  await page.goto(localUrl('/'));
  await openProfile(page);
  await page.fill('#aname', 'Anna');
  await page.click('[data-act=acreate]');
  await expect(page.locator('.acct-name')).toContainText('Anna');
  const anna = await account(page);
  await page.click('[data-act=home]');
  await toPlayers(page, { mode: 'score' });
  await page.fill('#name-0', 'Anna');
  await page.fill('#name-1', 'Ben');
  await page.click('[data-act=start]');
  expect((await live(page)).stats).toMatchObject({ owner: 0, ownerId: anna.id });
  for (let round = 1; round <= 3; round++) {
    await enterScore(page, 36, 1);
    await enterScore(page, 5);
    if (round < 3) await skipRace(page);
  }
  await expect(page.locator('.verdict')).toContainText('loses');
  const queued = () => page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-reports')).queue);
  await expect.poll(async () => (await queued()).length).toBe(1);
  expect((await queued())[0].ownerId).toBe(anna.id);

  // someone else signs in on this phone before the report goes out: it goes without a session
  await page.click('[data-act=again]');
  await page.click('[data-act=home]');
  await openProfile(page);
  await page.click('[data-act=asignout]');
  await page.fill('#aname', 'Cleo');
  await page.click('[data-act=acreate]');
  await expect(page.locator('.acct-name')).toContainText('Cleo');
  const sent = [];
  await page.unroute('**/report');
  await page.route('**/report', async route => {
    sent.push({ body: route.request().postDataJSON(), auth: await route.request().headerValue('authorization') });
    await route.fulfill({ status: 204 });
  });
  await page.reload();
  await openProfile(page);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].body.owner).toBe(0);
  expect(sent[0].auth).toBeNull();
  await ctx.close();
});
