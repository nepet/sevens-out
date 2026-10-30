// The party look: the owner's switch in the Developer fold, the look on the chosen player's phone, the reveal, and the
// short banner on friends' phones. Three passkey players (owner, chosen, stranger); the switch's rows are written straight
// into the Node server's database (setFlags), so these run against the Node server only, one after another.
import { test, expect } from '@playwright/test';
import { SERVER, localUrl, account, addAuthenticator, openProfile, openSettings, setFlags } from './helpers.js';

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
