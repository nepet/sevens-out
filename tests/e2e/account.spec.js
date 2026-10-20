// Your player: create a player with a passkey, sign in, rename, add a passkey, sign out and delete.
// Chromium's virtual authenticator (CDP) stands in for Face ID. WebAuthn refuses IP addresses as the
// relying party ID, so these tests open the page on localhost (LOCAL), not on the config's 127.0.0.1.
import { test, expect } from '@playwright/test';
import { SERVER, LOCAL, url, localUrl, account, storedAccount, addAuthenticator, credentials, copyCredential, noSideScroll } from './helpers.js';

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
const panel = page => page.locator('section.acct');
const hint = page => page.locator('.acct-hint');
const AUTH = SERVER ? SERVER.replace(/^ws/, 'http') : LOCAL; // where /auth answers: the page's own server, or wrangler dev

async function newPhone(browser, opts = {}) {
  const ctx = await browser.newContext({ ...phone, ...opts });
  const page = await ctx.newPage();
  const auth = await addAuthenticator(page);
  await page.goto(localUrl('/'));
  await expect(page.locator('[data-act=asignin]')).toBeVisible();
  return { ctx, page, auth };
}
async function createPlayer(page, name) {
  await page.fill('#aname', name);
  await page.click('[data-act=acreate]');
  await expect(page.locator('.acct-name')).toContainText(name);
  return account(page);
}
async function openFold(page) {
  const fold = page.locator('details[data-fold=account]');
  if (!(await fold.evaluate(d => d.open))) await fold.locator('summary').click();
}

test('create a player, stay signed in, sign out and back in, rename', async ({ browser }) => {
  const { ctx, page } = await newPhone(browser);
  await expect(panel(page)).toContainText('Your player');
  expect(await account(page)).toEqual({ available: true, signedIn: false, id: null, name: null });
  expect(await noSideScroll(page)).toBe(true);

  const me = await createPlayer(page, '  Anna  ');
  expect(me.signedIn).toBe(true);
  expect(me.name).toBe('Anna');
  expect(me.id).toMatch(/^[0-9a-f]{16}$/);
  await expect(page.locator('.acct-tag')).toHaveText(`#${me.id.slice(0, 4)}`);
  await expect(panel(page)).toContainText('Signed in');
  const saved = await storedAccount(page);
  expect(saved).toMatchObject({ id: me.id, name: 'Anna', server: AUTH });
  expect(saved.token).toMatch(/^[0-9a-f]{64}$/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-name')))).toBe('Anna');
  expect(JSON.stringify(await page.evaluate(() => window.SevensDebug.account))).not.toContain(saved.token);
  expect(await noSideScroll(page)).toBe(true);

  // a reload keeps the player (the page checks the session in the background)
  await page.reload();
  await expect(page.locator('.acct-name')).toContainText('Anna');
  expect((await account(page)).id).toBe(me.id);

  // sign out, then sign in again with the same passkey: the same player
  await openFold(page);
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
  await expect(page.locator('.acct-name')).toContainText('Annie');
  expect(await account(page)).toMatchObject({ id: me.id, name: 'Annie' });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sevens-out-name')))).toBe('Annie');
  await page.click('[data-act=online]');
  await expect(page.locator('.playing-as')).toHaveText(`Playing as Annie #${me.id.slice(0, 4)}`);
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

test('a dead session signs the phone out quietly', async ({ browser }) => {
  const { ctx, page } = await newPhone(browser);
  const me = await createPlayer(page, 'Dora');
  await page.evaluate(() => {
    const a = JSON.parse(localStorage.getItem('sevens-out-account'));
    localStorage.setItem('sevens-out-account', JSON.stringify({ ...a, token: '0'.repeat(64) }));
  });
  await page.reload();
  await expect(page.locator('[data-act=asignin]')).toBeVisible();
  expect(await storedAccount(page)).toBeNull();
  // an account saved for another server is ignored, not deleted
  await page.evaluate(id => localStorage.setItem('sevens-out-account', JSON.stringify({ token: 'f'.repeat(64), id, name: 'Dora', server: 'https://elsewhere.example' })), me.id);
  await page.reload();
  await expect(page.locator('[data-act=asignin]')).toBeVisible();
  expect((await storedAccount(page)).server).toBe('https://elsewhere.example');
  await ctx.close();
});

test('add a passkey: refused where the device has one, works on a second phone', async ({ browser }) => {
  const A = await newPhone(browser);
  const me = await createPlayer(A.page, 'Ben');
  await openFold(A.page);
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
  await openFold(B.page);
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
  await openFold(page);
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
  await page.fill('#aname', 'Eve');
  await page.click('[data-act=acreate]');
  await expect(hint(page)).toHaveText('No passkey was saved.');
  await expect(page.locator('[data-act=acreate]')).toBeEnabled();
  expect(await storedAccount(page)).toBeNull();
  await ctx.close();
});

test('the panel stays hidden where passkeys cannot work', async ({ browser }) => {
  // a browser without WebAuthn
  const ctx = await browser.newContext(phone);
  await ctx.addInitScript(() => { delete window.PublicKeyCredential; });
  const page = await ctx.newPage();
  await page.goto(localUrl('/'));
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[data-act=online]')).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  expect((await account(page)).available).toBe(false);
  await ctx.close();

  // an IP address can't be a passkey's relying party
  const ctx2 = await browser.newContext(phone);
  const page2 = await ctx2.newPage();
  await page2.goto(url('/'));
  await page2.waitForLoadState('networkidle');
  await expect(page2.locator('[data-act=online]')).toBeVisible();
  await expect(panel(page2)).toHaveCount(0);
  await ctx2.close();
});
