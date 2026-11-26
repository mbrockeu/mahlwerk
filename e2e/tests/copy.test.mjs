import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage, apiClient, today, shift, food } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser; const api = apiClient();
before(async () => {
  browser = await launch();
  await api('PATCH', 'me/settings', { tour_seen: true });
  const bread = await api('POST', 'foods', food('Copy Bread', 250, 9, 45, 3));
  const jam = await api('POST', 'foods', food('Copy Jam', 240, 0, 60, 0));
  for (const f of [bread, jam]) await api('POST', `diary/${shift(today(), -1)}/entries`, { meal: 'breakfast', food_id: f.id, amount: 60 });
});
after(() => browser.close());

const breakfast = async () => (await api('GET', `diary/${today()}`)).meals.breakfast.entries.length;

test('same as yesterday: the meal offers to take it back after the message is gone', async () => {
  await withPage(browser, 'copy', async (page) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Same as yesterday/ }).first().click();
    await expect(page.getByText('Entries copied: 2')).toBeVisible();
    assert.equal(await breakfast(), 2);
    // the undo in the meal does not depend on the message
    await page.getByRole('button', { name: /Undo “Same as yesterday”/ }).click();
    await expect(page.getByText('Undone', { exact: true })).toBeVisible();
    assert.equal(await breakfast(), 0);
    await expect(page.getByRole('button', { name: /Same as yesterday/ }).first()).toBeVisible();
  });
});
