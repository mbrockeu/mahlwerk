import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage, apiClient } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser; const api = apiClient();
before(async () => { browser = await launch(); await api('PATCH', 'me/settings', { tour_seen: true }); });
after(() => browser.close());

test('profile: display name, a setting and the calorie goal survive a reload', async () => {
  await withPage(browser, 'settings', async (page) => {
    await page.goto('/#/profile');
    await page.getByRole('button', { name: 'Change name' }).click();
    await page.getByLabel('Change display name').fill('Smoke Tester');
    await page.getByLabel('Change display name').press('Enter');
    await expect(page.getByText('Smoke Tester').first()).toBeVisible();

    await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'Appearance & use' }).click();                  // the settings are one section at a time
    await page.getByRole('switch', { name: /^Suggestions on the day view/ }).click();   // On -> Off
    await expect(page.getByRole('switch', { name: /^Suggestions on the day view/ })).toHaveAttr('aria-checked', 'false');

    await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'Goals' }).click();
    await page.getByRole('textbox', { name: 'Calorie goal in kcal' }).fill('2300');
    await page.getByRole('textbox', { name: 'Calorie goal in kcal' }).blur();
    await page.getByRole('region', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save' }).click();

    // saving the goal returns to the day view, which shows it
    await expect(page.getByText('2,300').first()).toBeVisible();
    const me = await api('GET', 'me');
    assert.equal(me.display_name, 'Smoke Tester');
    assert.equal(me.settings.suggestions, false);
    assert.equal(me.goal.kcal, 2300);

    // and after a reload the page shows the same
    await page.goto('/#/profile');
    await page.reload();
    await expect(page.getByText('Smoke Tester').first()).toBeVisible();
    assert.equal(await page.getByRole('textbox', { name: 'Calorie goal in kcal' }).inputValue(), '2,300');
    await page.getByRole('navigation', { name: 'Profile sections' }).getByRole('link', { name: 'Appearance & use' }).click();
    await expect(page.getByRole('switch', { name: /^Suggestions on the day view/ })).toHaveAttr('aria-checked', 'false');
  });
});
