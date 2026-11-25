import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage, apiClient, today, shift, food } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser; const api = apiClient();
before(async () => {
  browser = await launch();
  await api('PATCH', 'me/settings', { tour_seen: true });
  const oats = await api('POST', 'foods', food('Smoke Oats', 370, 13, 60, 7));
  for (const ago of [0, 1, 2, 3]) await api('POST', `diary/${shift(today(), -ago)}/entries`, { meal: 'breakfast', food_id: oats.id, amount: 100 });
});
after(() => browser.close());

test('insights: every tab renders its content, the help sheet opens', async () => {
  await withPage(browser, 'insights', async (page) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Insights' }).click();
    const panel = page.getByRole('tabpanel');
    await expect(panel).toContainText('Average per logged day'.toUpperCase());
    for (const [tab, marker] of [['Eating', 'CALORIES PER DAY'], ['Body', 'ESTIMATED EXPENDITURE'], ['Nutrients', 'NUTRIENT OVER TIME'], ['Foods', 'BIGGEST CONTRIBUTORS'], ['Overview', 'CALENDAR']]) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await expect(panel).toContainText(marker);
    }
    await page.getByRole('tab', { name: 'Foods', exact: true }).click();
    await expect(panel).toContainText('Smoke Oats');
    await page.getByRole('button', { name: '30 days', exact: true }).click();   // period chip re-queries
    await expect(panel).toContainText('Smoke Oats');
    await page.getByRole('button', { name: 'Help: what the evaluation shows' }).click();
    await expect(page.getByRole('dialog', { name: 'Help' })).toBeVisible();
  });
});

test('day view: macro tile opens the macro sheet, help sheet opens', async () => {
  await withPage(browser, 'macro', async (page) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^Protein, / }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('BY MEAL');
    await expect(sheet).toContainText('Smoke Oats');
    await sheet.getByRole('tab', { name: 'Carbohydrates' }).click();
    await expect(sheet).toContainText('60 g');
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Start the tour');
  });
});
