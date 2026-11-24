import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage, apiClient } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser; const api = apiClient();
before(async () => { browser = await launch(); await api('PATCH', 'me/settings', { tour_seen: true }); });
after(() => browser.close());

test('own food: create with nutrients, set piece and drink flag, find it in search and recent', async () => {
  await withPage(browser, 'food', async (page) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Products' }).click();
    await page.getByRole('button', { name: 'New product' }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Name', { exact: true }).fill('Smoke Juice');
    await editor.getByLabel(/^Values per 100/).selectOption('ml');
    await editor.getByLabel('Energy (kcal)').fill('45');
    await editor.getByLabel('Protein (g)').fill('0.5');
    await editor.getByLabel('Carbohydrates (g)').fill('10');
    await editor.getByLabel(/^Fat \(/).fill('0.1');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();

    // detail view lists what was entered
    await page.getByRole('button', { name: /Smoke Juice/ }).first().click();
    await expect(page.getByText('45 kcal', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Add to diary' }).click();

    // piece + drink flag are set in the amount sheet
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'Set a piece' }).click();
    await sheet.getByLabel('Name', { exact: true }).fill('glass');
    await sheet.getByLabel(/^Weight of one piece/).fill('200');
    await sheet.getByRole('button', { name: 'Save piece' }).click();
    await sheet.getByRole('group', { name: 'Counts as a drink' }).getByRole('button', { name: 'yes' }).click();
    await expect(sheet.getByRole('button', { name: 'yes', exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Add to diary' }).click();

    const [saved] = await api('GET', 'foods?q=Smoke%20Juice&limit=5');
    assert.equal(saved.name, 'Smoke Juice');
    assert.equal(saved.unit, 'ml');
    assert.equal(saved.per_100.kcal, 45);
    assert.equal(saved.piece?.label, 'glass');
    assert.equal(saved.piece?.grams, 200);
    assert.equal(saved.drink, true);

    // shows up in search and in recent of the add sheet
    await page.getByRole('link', { name: 'Today' }).click();
    await page.getByRole('button', { name: 'Add to Lunch' }).click();
    const add = page.getByRole('dialog');
    await add.getByRole('tab', { name: 'Recent' }).click();
    await expect(add.getByRole('button', { name: /Smoke Juice/ })).toBeVisible();
    await add.getByRole('tab', { name: 'Search' }).click();
    await add.getByRole('searchbox', { name: 'Name, brand or barcode' }).fill('smoke jui');
    await expect(add.getByRole('button', { name: /Smoke Juice/ })).toBeVisible();
  });
});
