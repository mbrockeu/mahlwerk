// Only in app mode (run.sh app): the catalogue file of the device (BLS fixture, SQLite WASM with FTS5) is searched in the page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { APP, launch, withPage, apiClient } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser; const api = apiClient();
before(async () => { if (!APP) return; browser = await launch(); await api('PATCH', 'me/settings', { tour_seen: true }); });
after(() => browser?.close());

test('app: a basic food from the catalogue on the device, found and added', { skip: !APP && 'app mode only' }, async () => {
  const hits = await api('GET', 'catalog?q=hafer');
  assert.equal(hits[0]?.name, 'Haferflocken');
  const me = await api('GET', 'me');
  assert.deepEqual(me.features, { access_tokens: false, webhooks: false, cookidoo: false, web_recipes: false });
  await withPage(browser, 'app-catalog', async (page) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add to Breakfast' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('searchbox', { name: 'Name, brand or barcode' }).fill('Haferfl');
    await sheet.getByRole('button', { name: /Oat flakes/ }).click(); // the English name in an English interface
    await page.getByLabel('Amount (g)').fill('50');
    await page.getByRole('button', { name: 'Add to diary' }).click();
    await expect(page.getByRole('button', { name: /^Breakfast/ })).toContainText('185'); // 50 g * 3.7 kcal
  });
});
