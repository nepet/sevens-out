// Your player: create a player with a passkey, sign in, rename, add a passkey, sign out and delete.
// Chromium's virtual authenticator (CDP) stands in for Face ID. WebAuthn refuses IP addresses as the
// relying party ID, so these tests open the page on localhost (LOCAL), not on the config's 127.0.0.1.
import { test, expect } from '@playwright/test';
import { AUTH, url, localUrl, account, storedAccount, addAuthenticator, credentials, copyCredential, noSideScroll, openYou } from './helpers.js';

// the account panel lives on your player's screen, opened from home's profile chip

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
const panel = page => page.locator('section.acct');
const hint = page => page.locator('.acct-hint');

async function newPhone(browser, opts = {}) {
  const ctx = await browser.newContext({ ...phone, ...opts });
  const page = await ctx.newPage();
  const auth = await addAuthenticator(page);
  await page.goto(localUrl('/'));
  await openYou(page);
  await expect(page.locator('[data-act=asignin]')).toBeVisible();
  return { ctx, page, auth };
}
async function createPlayer(page, name) {
  await page.fill('#aname', name);
  await page.click('[data-act=acreate]');
  await expect(page.locator('.acct-name')).toContainText(name);
  return account(page);
}

test('create a player, stay signed in, sign out and back in, rename', async ({ browser }) => {
  const { ctx, page } = await newPhone(browser);
  await expect(panel(page)).toContainText('Keep your scores');
  expect(await account(page)).toEqual({ available: true, signedIn: false, id: null, name: null });
  expect(await noSideScroll(page)).toBe(true);

  const me = await createPlayer(page, '  Anna  ');
  expect(me.signedIn).toBe(true);
  expect(me.name).toBe('Anna');
  expect(me.id).toMatch(/^[0-9a-f]{16}$/);
  await expect(page.locator('.acct-tag')).toHaveText(`#${me.id.slice(0, 4)}`);
  await expect(page.locator('[data-act=asignout]')).toBeVisible();
  const saved = await storedAccount(page);
  expect(saved).toMatchObject({ id: me.id, name: 'Anna' });
  expect(saved.token).toMatch(/^[0-9a-f]{64}$/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-name')))).toBe('Anna');
  expect(JSON.stringify(await page.evaluate(() => window.SevensDebug.account))).not.toContain(saved.token);
  expect(await noSideScroll(page)).toBe(true);

  // a reload keeps the player (the page checks the session in the background)
  await page.reload();
  await openYou(page);
  await expect(page.locator('.acct-name')).toContainText('Anna');
  expect((await account(page)).id).toBe(me.id);

  // sign out, then sign in again with the same passkey: the same player
  await page.click('[data-act=asignout]');
  await expect(page.locator('[data-act=asignin]')).toBeVisible();
  expect(await storedAccount(page)).toBeNull();
  expect((await account(page)).signedIn).toBe(false);
  // the server forgot the session too
  await expect.poll(async () => (await page.request.get(`${AUTH}/auth/me`, { headers: { authorization: `Bearer ${saved.token}` } })).status()).toBe(401);
  await page.click('[data-act=asignin]');
  await expect(page.locator('.acct-name')).toContainText('Anna');
  expect((await account(page)).id).toBe(me.id);
  await expect(hint(page)).toHaveText('Signed in as Anna.');

  // rename: Enter saves; the new name survives a reload and is the name online
  await page.click('[data-act=arename]');
  await expect(page.locator('#arename')).toBeFocused();
  await page.click('[data-act=arenamecancel]');
  await expect(page.locator('#arename')).toHaveCount(0);
  await page.click('[data-act=arename]');
  await page.fill('#arename', 'Annie');
  await page.press('#arename', 'Enter');
  await expect(page.locator('.acct-name')).toContainText('Annie');
  await expect(hint(page)).toHaveText('Name saved.');
  await page.reload();
  await openYou(page);
  await expect(page.locator('.acct-name')).toContainText('Annie');
  expect(await account(page)).toMatchObject({ id: me.id, name: 'Annie' });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-name')))).toBe('Annie');
  await page.click('[data-act=home]');
  const chip = page.locator('.home-head [data-act=profile]');
  await expect(chip).toHaveAttribute('aria-label', 'Your player: Annie');
  await expect(chip).toHaveText('Annie');
  await expect(chip.locator('.ava')).toHaveAttribute('data-i', 'A');
  await ctx.close();
});

test('home\'s profile chip: "Sign in" for a guest, the name and initial when signed in; it opens your player, Back returns home', async ({ browser }) => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await addAuthenticator(page);
  await page.goto(localUrl('/'));
  const chip = page.locator('.home-head [data-act=profile]');
  await expect(chip).toHaveText('Sign in');
  await expect(chip.locator('svg')).toHaveCount(1);                  // the person icon
  const box = await chip.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.y).toBeLessThan(80);
  await chip.click();
  await expect(page.locator('[data-act=asignin]')).toBeVisible();
  await expect(page.locator('nav.tabbar')).toHaveCount(0);
  await page.fill('#aname', 'Bea');
  await page.click('[data-act=acreate]');
  await expect(page.locator('.acct-name')).toContainText('Bea');
  await page.click('.menubtn[data-act=home][aria-label=Back]');
  await expect(page.locator('[data-act=play]')).toBeVisible();
  await expect(chip).toHaveAttribute('aria-label', 'Your player: Bea');
  await expect(chip.locator('.ava')).toHaveAttribute('data-i', 'B');
  expect(await noSideScroll(page)).toBe(true);
  await ctx.close();
});

test('Enter in the name field creates the player; an empty name asks for one', async ({ browser }) => {
  const { ctx, page } = await newPhone(browser);
  await page.fill('#aname', '   ');
  await page.click('[data-act=acreate]');
  await expect(hint(page)).toContainText('Enter your name first');
  await page.fill('#aname', 'Cleo');
  await page.press('#aname', 'Enter');
  await expect(page.locator('.acct-name')).toContainText('Cleo');
  await ctx.close();
});

test('accounts are kept per server; an old saved account still works; a dead session signs the phone out quietly', async ({ browser }) => {
  const { ctx, page } = await newPhone(browser);
  const me = await createPlayer(page, 'Dora');
  const good = await storedAccount(page);
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('sevens-out-account'))))).toEqual([AUTH]);

  // the single account saved before accounts were kept per server
  await page.evaluate(([a, server]) => localStorage.setItem('sevens-out-account', JSON.stringify({ ...a, server })), [good, AUTH]);
  await page.reload();
  await openYou(page);
  await expect(page.locator('.acct-name')).toContainText('Dora');
  expect((await account(page)).id).toBe(me.id);

  // a session that ended: dropped on load; the account kept for another server stays
  const other = { token: 'f'.repeat(64), id: me.id, name: 'Dora' };
  await page.evaluate(([a, server, other]) => localStorage.setItem('sevens-out-account', JSON.stringify({ [server]: { ...a, token: '0'.repeat(64) }, 'https://elsewhere.example': other })), [good, AUTH, other]);
  await page.reload();
  await openYou(page);
  await expect(page.locator('[data-act=asignin]')).toBeVisible();
  await expect.poll(() => storedAccount(page)).toBeNull();
  expect(await storedAccount(page, 'https://elsewhere.example')).toEqual(other);
  await ctx.close();
});

test('add a passkey: refused where the device has one, works on a second phone', async ({ browser }) => {
  const A = await newPhone(browser);
  const me = await createPlayer(A.page, 'Ben');
  await A.page.click('[data-act=aadd]');
  await expect(hint(A.page)).toHaveText('This device already has a passkey for Ben.');
  expect(await credentials(A.auth)).toHaveLength(1);

  // phone B gets the synced passkey, signs in with it, then the copy goes away (as if B had used
  // a phone nearby by QR code); B can now add its own passkey
  const B = await newPhone(browser);
  const copy = await copyCredential(A.auth, B.auth);
  await B.page.click('[data-act=asignin]');
  await expect(B.page.locator('.acct-name')).toContainText('Ben');
  expect((await account(B.page)).id).toBe(me.id);
  await B.auth.cdp.send('WebAuthn.removeCredential', { authenticatorId: B.auth.authenticatorId, credentialId: copy.credentialId });
  await B.page.click('[data-act=aadd]');
  await expect(hint(B.page)).toHaveText('Passkey added. You can sign in with it on this device.');
  const own = await credentials(B.auth);
  expect(own).toHaveLength(1);
  expect(own[0].credentialId).not.toBe(copy.credentialId);

  // B's own passkey signs in as the same player
  await B.page.click('[data-act=asignout]');
  await B.page.click('[data-act=asignin]');
  await expect(B.page.locator('.acct-name')).toContainText('Ben');
  expect((await account(B.page)).id).toBe(me.id);
  await A.ctx.close(); await B.ctx.close();
});

test('delete the player after a confirmation; its passkey then says so', async ({ browser }) => {
  const { ctx, page, auth } = await newPhone(browser);
  const me = await createPlayer(page, 'Cleo');
  const [cred] = await credentials(auth);
  await page.click('[data-act=adelete]');
  await expect(page.locator('.acct .confirm')).toContainText(`Delete Cleo #${me.id.slice(0, 4)}? Your passkey stops working here and your stats keep only the name.`);
  await page.click('[data-act=adeleteno]');
  await expect(page.locator('.acct .confirm')).toHaveCount(0);
  expect((await account(page)).signedIn).toBe(true);
  await page.click('[data-act=adelete]');
  await page.click('[data-act=adeleteyes]');
  await expect(page.locator('[data-act=asignin]')).toBeVisible();
  await expect(hint(page)).toHaveText(`Deleted Cleo #${me.id.slice(0, 4)}.`);
  expect(await storedAccount(page)).toBeNull();

  // the page tells the password manager that the player has no passkeys left (signalAllAcceptedCredentials)
  await expect.poll(async () => (await credentials(auth)).length).toBe(0);
  // a copy elsewhere (another phone, a password manager that ignores the signal) says what happened, then is hidden too
  await copyCredential(null, auth, cred);
  await page.click('[data-act=asignin]');
  await expect(hint(page)).toHaveText("That passkey's player was deleted. Create a new player.");
  expect((await account(page)).signedIn).toBe(false);
  await expect.poll(async () => (await credentials(auth)).length).toBe(0);
  await ctx.close();
});

test('a sign-in without a passkey on the device is cancelled quietly', async ({ browser }) => {
  const { ctx, page } = await newPhone(browser);
  await page.click('[data-act=asignin]');
  await expect(hint(page)).toHaveText('Sign-in cancelled.');
  await expect(page.locator('[data-act=asignin]')).toBeEnabled();
  expect((await account(page)).signedIn).toBe(false);
  await ctx.close();
});

test('a cancelled passkey prompt saves nothing', async ({ browser }) => {
  // the virtual authenticator can't cancel, so the system sheet's Cancel is stood in for
  const ctx = await browser.newContext(phone);
  await ctx.addInitScript(() => {
    navigator.credentials.create = () => Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
  });
  const page = await ctx.newPage();
  await page.goto(localUrl('/'));
  await openYou(page);
  await page.fill('#aname', 'Eve');
  await page.click('[data-act=acreate]');
  await expect(hint(page)).toHaveText('No passkey was saved.');
  await expect(page.locator('[data-act=acreate]')).toBeEnabled();
  expect(await storedAccount(page)).toBeNull();
  await ctx.close();
});

test('passkey options are fetched ahead, so the prompt opens right inside the tap', async ({ browser }) => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  const auth = await addAuthenticator(page);
  const options = [];
  page.on('request', r => { if (r.url().endsWith('/auth/options')) options.push(r.postDataJSON().purpose); });
  const answered = [];
  page.on('requestfinished', r => { if (r.url().endsWith('/auth/options')) answered.push(r); });
  await page.goto(localUrl('/'));
  await openYou(page);
  await expect(page.locator('[data-act=acreate]')).toBeVisible();
  await expect.poll(() => answered.length).toBe(2); // one set for sign-in, one for a new player
  expect(options.sort()).toEqual(['create', 'signin']);

  const before = options.length;
  let atCreate = null;
  page.on('request', r => { if (r.url().endsWith('/auth/create') && atCreate === null) atCreate = options.length; });
  await page.fill('#aname', 'Fay');
  await page.click('[data-act=acreate]');
  await expect(page.locator('.acct-name')).toContainText('Fay');
  expect(atCreate).toBe(before); // no options request between the tap and the passkey
  const me = await account(page);
  const [cred] = await credentials(auth);
  expect(cred.userName).toBe(`Fay #${me.id.slice(0, 4)}`);
  expect(cred.userDisplayName).toBe('Fay');

  // signed in: the fold fetches a set for adding a passkey
  await expect.poll(() => options.filter(p => p === 'add').length).toBe(1);
  await ctx.close();
});

test('without options fetched ahead, a tap fetches them first', async ({ browser }) => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  await addAuthenticator(page);
  let n = 0;
  const purposes = [];
  await page.route('**/auth/options', route => { purposes.push(route.request().postDataJSON().purpose); return ++n <= 2 ? route.abort('internetdisconnected') : route.continue(); });
  await page.goto(localUrl('/'));
  await openYou(page);
  await expect(page.locator('[data-act=acreate]')).toBeVisible();
  await expect.poll(() => n).toBe(2);
  expect([...purposes].sort()).toEqual(['create', 'signin']); // both sets fetched ahead, both failed
  await page.fill('#aname', 'Gus');
  await page.click('[data-act=acreate]');
  await expect(page.locator('.acct-name')).toContainText('Gus');
  // the tap fetched its own create set (used once); signed in, the You tab then fetches one set for adding a passkey, and nothing more
  await expect.poll(() => purposes.length).toBe(4);
  expect(purposes.slice(2)).toEqual(['create', 'add']);
  await page.waitForTimeout(500);
  expect(purposes).toHaveLength(4);
  await ctx.close();
});

test('during a passkey prompt the buttons ignore taps and keep focus, and the hint is announced', async ({ browser }) => {
  const ctx = await browser.newContext(phone);
  await ctx.addInitScript(() => { navigator.credentials.create = () => new Promise(() => {}); }); // a prompt left open
  const page = await ctx.newPage();
  await page.goto(localUrl('/'));
  await openYou(page);
  await page.fill('#aname', 'Hal');
  await page.click('[data-act=acreate]');
  await expect(page.locator('[data-act=acreate]')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('[data-act=acreate]')).toBeFocused();
  await expect(page.locator('#acct-live')).toHaveText('Waiting for your passkey…');
  await expect(page.locator('#acct-live')).toHaveAttribute('aria-live', 'polite');
  await page.locator('[data-act=asignin]').dispatchEvent('click');
  await expect(page.locator('.acct-hint')).toHaveText('Waiting for your passkey…');
  await ctx.close();
});

test('a probe that failed is tried again when the phone is back online; a 404 is not', async ({ browser }) => {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  let probes = 0, mode = 'offline';
  await page.route('**/auth/config', route => { probes++; return mode === 'offline' ? route.abort('internetdisconnected') : mode === '404' ? route.fulfill({ status: 404, body: '{}' }) : route.continue(); });
  await page.goto(localUrl('/'));
  const chip = p => p.locator('.home-head [data-act=profile]');
  await expect.poll(() => probes).toBe(1);
  await expect(chip(page)).toHaveCount(0);                         // no profile chip (and so no panel) yet
  mode = '404';
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await expect.poll(() => probes).toBe(2);
  mode = 'ok';
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForTimeout(300);
  expect(probes).toBe(2); // no accounts on that server: no more probes
  await expect(chip(page)).toHaveCount(0);

  const ctx2 = await browser.newContext(phone);
  const page2 = await ctx2.newPage();
  let n = 0;
  await page2.route('**/auth/config', route => (++n === 1 ? route.abort('internetdisconnected') : route.continue()));
  await page2.goto(localUrl('/'));
  await expect.poll(() => n).toBe(1);
  await expect(chip(page2)).toHaveCount(0);
  await page2.evaluate(() => dispatchEvent(new Event('online')));
  await expect(chip(page2)).toHaveText('Sign in');                 // home redraws with the chip
  await openYou(page2);
  await expect(panel(page2)).toBeVisible();
  await ctx.close(); await ctx2.close();
});

test('the panel stays hidden where passkeys cannot work', async ({ browser }) => {
  // a browser without WebAuthn
  const ctx = await browser.newContext(phone);
  await ctx.addInitScript(() => { delete window.PublicKeyCredential; });
  const page = await ctx.newPage();
  await page.goto(localUrl('/'));
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.home-head [data-act=settings]')).toBeVisible();
  await expect(page.locator('.home-head [data-act=profile]')).toHaveCount(0);  // no profile chip, so no panel
  await expect(panel(page)).toHaveCount(0);
  expect((await account(page)).available).toBe(false);
  await ctx.close();

  // an IP address can't be a passkey's relying party
  const ctx2 = await browser.newContext(phone);
  const page2 = await ctx2.newPage();
  await page2.goto(url('/'));
  await page2.waitForLoadState('networkidle');
  await expect(page2.locator('.home-head [data-act=settings]')).toBeVisible();
  await expect(page2.locator('.home-head [data-act=profile]')).toHaveCount(0);
  await expect(panel(page2)).toHaveCount(0);
  await ctx2.close();
});
