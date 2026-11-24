import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage, apiClient, today } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser; const api = apiClient();
before(async () => {
  browser = await launch();
  await api('PATCH', 'me/settings', { tour_seen: true, fasting: { enabled: true } });
});
after(() => browser.close());

test('water: add glasses, take one back; the day total follows', async () => {
  await withPage(browser, 'water', async (page) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add 250 ml of water' }).click();
    await page.getByRole('button', { name: 'Add 500 ml of water' }).click();
    await expect(page.getByText('0.75', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Take back/ }).click();
    await expect(page.getByText('0.5', { exact: true })).toBeVisible();
    assert.equal((await api('GET', `diary/${today()}`)).water.ml, 500);
  });
});

test('fasting: start and end a fast', async () => {
  await withPage(browser, 'fasting', async (page) => {
    await page.goto('/');
    const card = page.getByRole('region', { name: 'Fasting' });
    await card.getByRole('button', { name: /Start fasting/ }).click();
    await expect(card.getByRole('button', { name: 'End fast' })).toBeVisible();
    assert.ok((await api('GET', 'fasting')).current, 'a fast is running on the server');
    await card.getByRole('button', { name: 'End fast' }).click();
    await expect(card.getByRole('button', { name: /Start fasting/ })).toBeVisible();
    await expect(card).toContainText('Last fast');
    const f = await api('GET', 'fasting');
    assert.equal(f.current, null);
    assert.ok(f.last?.ended_at, 'the finished fast is stored');
  });
});
