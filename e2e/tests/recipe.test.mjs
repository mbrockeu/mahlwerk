import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage, apiClient, food } from '../lib.mjs';
import { expect } from '../expect.mjs';

let browser; const api = apiClient();
before(async () => {
  browser = await launch();
  await api('PATCH', 'me/settings', { tour_seen: true });
  await api('POST', 'foods', food('Smoke Flour', 350, 10, 70, 1));
  await api('POST', 'foods', { ...food('Smoke Milk', 50, 3, 5, 2), unit: 'ml' });
});
after(() => browser.close());

async function addIngredient(page, name, amount) {
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  const picker = page.getByRole('dialog').last();
  await picker.getByRole('searchbox', { name: 'Name, brand or barcode' }).fill(name);
  await picker.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('textbox', { name: new RegExp(`^Amount of ${name}`) }).fill(String(amount));
}

test('recipe: build from two foods, log a portion; template: save a meal, apply it on another day', async () => {
  await withPage(browser, 'recipe', async (page) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Recipes' }).click();
    await page.getByRole('button', { name: 'New recipe' }).first().click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Name', { exact: true }).fill('Smoke Pancakes');
    await addIngredient(page, 'Smoke Flour', 200);
    await addIngredient(page, 'Smoke Milk', 300);
    await expect(page.getByText('425', { exact: false }).first()).toBeVisible();   // 2 portions: (700 + 150) / 2 kcal
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Smoke Pancakes').first()).toBeVisible();
    const [recipe] = await api('GET', 'recipes');
    assert.equal(recipe.food.name, 'Smoke Pancakes');
    assert.equal(recipe.items.length, 2);

    // log one portion for lunch
    await page.getByRole('link', { name: 'Today' }).click();
    await page.getByRole('button', { name: 'Add to Lunch' }).click();
    const add = page.getByRole('dialog');
    await add.getByRole('searchbox', { name: 'Name, brand or barcode' }).fill('Smoke Pancakes');
    await add.getByRole('button', { name: /Smoke Pancakes/ }).click();
    await page.getByRole('button', { name: 'Add to diary' }).click();
    const lunch = page.getByRole('button', { name: /^Lunch/ });
    await expect(lunch).toContainText('425');

    // template from that meal, applied to tomorrow's breakfast
    await lunch.click();
    await page.getByRole('button', { name: 'Save as template' }).click();
    await page.getByRole('textbox').last().fill('Smoke Lunch');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Template saved').first()).toBeVisible();
    await page.getByRole('button', { name: 'Next day' }).click();
    await page.getByRole('button', { name: 'Add to Breakfast' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('tab', { name: 'Templates' }).click();
    await sheet.getByRole('button', { name: /^Smoke Lunch/ }).click();
    await expect(page.getByRole('button', { name: /^Breakfast/ })).toContainText('425');
  });
});
