import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage, apiClient, today, shift } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser; const api = apiClient();
before(async () => {
  browser = await launch();
  await api('PATCH', 'me/settings', { tour_seen: true });
  for (const [ago, kg] of [[40, 80.4], [20, 79.8], [10, 79], [3, 79.7]]) await api('PUT', `weights/${shift(today(), -ago)}`, { kg });
});
after(() => browser.close());

test('weight: enter today, chart period chips switch the chart', async () => {
  await withPage(browser, 'weight', async (page) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Weight' }).click();
    await page.getByRole('textbox').first().fill('78.4');
    await page.getByRole('button', { name: 'Save weight' }).click();
    await expect(page.getByText('78.4 kg', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('img', { name: 'Weight, last 90 days' })).toBeVisible();
    const chips = page.getByRole('group', { name: 'Time range' });
    for (const [chip, label] of [['30 days', 'Weight, last 30 days'], ['Year', 'Weight, last 365 days'], ['All', 'Weight, all values'], ['90 days', 'Weight, last 90 days']]) {
      await chips.getByRole('button', { name: chip }).click();
      await expect(page.getByRole('img', { name: label })).toBeVisible();
    }
    const points = await api('GET', 'weights?days=90');
    assert.equal(points.find((p) => p.day === today())?.kg, 78.4);
    assert.equal(points.length, 5);
  });
});
