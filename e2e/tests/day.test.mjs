import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage, apiClient, food } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser; const api = apiClient();
before(async () => { browser = await launch(); await api('PATCH', 'me/settings', { tour_seen: true }); });
after(() => browser.close());

test('day: search an own food, add it, change the amount, delete the entry', async () => {
  await api('POST', 'foods', food('Smoke Oatmeal', 370, 13, 60, 7));
  await withPage(browser, 'day', async (page) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add to Breakfast' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('searchbox', { name: 'Name, brand or barcode' }).fill('Smoke Oat');
    await sheet.getByRole('button', { name: /Smoke Oatmeal/ }).click();
    await page.getByLabel('Amount (g)').fill('150');
    await page.getByRole('button', { name: 'Add to diary' }).click();

    const breakfast = page.getByRole('button', { name: /^Breakfast/ });
    await expect(breakfast).toContainText('555');                       // 150 g * 3.7 kcal
    await expect(page.getByText('555', { exact: true }).first()).toBeVisible(); // the ring total
    await breakfast.click();
    await page.getByRole('button', { name: 'Smoke Oatmeal, 150 g, 555 kcal' }).click();
    await page.getByLabel('Amount (g)').fill('200');
    await page.getByRole('button', { name: 'Save change' }).click();
    await expect(breakfast).toContainText('740');
    await expect(page.getByRole('button', { name: 'Smoke Oatmeal, 200 g, 740 kcal' })).toBeVisible();

    await page.getByRole('button', { name: 'Smoke Oatmeal, 200 g, 740 kcal' }).click();
    await page.getByRole('button', { name: 'Delete entry' }).click();
    await page.getByRole('button', { name: 'Really delete?' }).click();
    await expect(page.getByRole('button', { name: /Smoke Oatmeal, 200 g/ })).toHaveCount(0);
    await expect(breakfast).not.toContainText('740');
    await expect(page.getByText('Nothing yet').first()).toBeVisible();
  });
});
