// Runs with MAHLWERK_AUTH=local (run.sh picks the mode from the file name): first-admin setup, sign out, sign in, wrong password.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser;
before(async () => { assert.equal(process.env.MW_AUTH, 'local'); browser = await launch(); });
after(() => browser.close());

const PASSWORD = 'smoke test password 42';

test('local auth: first-admin setup, sign out, wrong password refused, sign in again', async () => {
  await withPage(browser, 'auth', async (page) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    await page.getByLabel('User name').fill('smokeadmin');
    await page.getByLabel('Display name (optional)').fill('Smoke Admin');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Repeat password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();   // signed in right after the setup

    await page.goto('/#/profile');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await page.getByLabel('User name').fill('smokeadmin');
    await page.getByLabel('Password', { exact: true }).fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('User name or password is wrong.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Today' })).toHaveCount(0);

    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.reload();                                                         // the session cookie holds (the page stays on the profile)
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });
});
