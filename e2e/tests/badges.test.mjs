import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage, apiClient, today, shift, food } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser; const api = apiClient();
before(async () => {
  browser = await launch();
  await api('PATCH', 'me/settings', { tour_seen: true });
  const oats = await api('POST', 'foods', food('Smoke Oats', 370, 13, 60, 7));
  for (let ago = 0; ago < 10; ago++) await api('POST', `diary/${shift(today(), -ago)}/entries`, { meal: 'breakfast', food_id: oats.id, amount: 100 });
  for (let ago = 0; ago < 10; ago += 2) await api('POST', 'workouts', { day: shift(today(), -ago), kind: 'running', minutes: 40, kcal: 300 });
});
after(() => browser.close());

test('badges: the badge page, the training card', async () => {
  await withPage(browser, 'badges', async (page) => {
    await page.goto('/');
    await page.goto('/#/badges');
    await expect(page.getByRole('button', { name: 'First entry, earned' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'First workout, earned' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Home cook, / })).toBeVisible();   // one that is still open

    await page.goto('/#/history');
    await page.getByRole('tab', { name: 'Body', exact: true }).click();
    const card = page.getByRole('region', { name: 'Training and eating' });
    await expect(card).toContainText('5 training days, 200 min of workouts');
    await expect(card).toContainText('TRAINING DAYS PER WEEK');
  });
});
