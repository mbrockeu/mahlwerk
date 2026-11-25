import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, withPage, apiClient, today, food, APP } from '../lib.mjs';

// The import of an own export (profile): only where GET /me offers it (TS server, app); the Python server has none.
const PYTHON = process.env.MW_TARGET === 'python';
let browser; const api = apiClient();
let entryId;
before(async () => {
  browser = await launch();
  await api('PATCH', 'me/settings', { tour_seen: true });
  const oats = await api('POST', 'foods', food('Import Oats', 370, 13, 60, 7));
  entryId = (await api('POST', `diary/${today()}/entries`, { meal: 'breakfast', food_id: oats.id, amount: 100 })).id;
  await api('PUT', `weights/${today()}`, { kg: 78.4 });
});
after(() => browser.close());

test('import: export, lose an entry, import the file again (merge), then replace', async () => {
  await withPage(browser, 'import', async (page) => {
    await page.goto('/#/profile');
    await page.getByRole('heading', { name: 'Export my data' }).waitFor();
    if (PYTHON) {
      assert.equal(await page.getByTestId('data-import').count(), 0, 'the Python server offers no import');
      return;
    }
    if (APP) await page.getByTestId('app-only-note').getByText('Your data lives only on this iPhone').waitFor();
    else assert.equal(await page.getByTestId('app-only-note').count(), 0);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download ZIP' }).click()]);
    const file = await download.path();
    await api('DELETE', `diary/entries/${entryId}`);
    await api('PUT', `weights/${today()}`, { kg: 80 });

    // merge: the entry comes back, the weight of the file wins
    const card = page.getByTestId('data-import');
    await card.locator('input[type=file]').setInputFiles({ name: 'mahlwerk-export.zip', mimeType: 'application/zip', buffer: await import('node:fs').then((fs) => fs.readFileSync(file)) });
    const preview = page.getByTestId('import-preview');
    await preview.getByText(/Where a row with the same id is here already, the file wins/).waitFor();
    const diaryRow = preview.getByRole('row', { name: /Diary entries/ });
    assert.deepEqual(await diaryRow.getByRole('cell').allTextContents(), ['1', '0', '0', '0']);
    assert.deepEqual(await preview.getByRole('row', { name: /Weights/ }).getByRole('cell').allTextContents(), ['0', '1', '0', '0']);
    await preview.getByRole('button', { name: 'Import now' }).click();
    await page.getByTestId('import-done').getByText('Imported: 1 new, 1 updated.').waitFor();
    const day = await api('GET', `diary/${today()}`);
    assert.deepEqual(day.meals.breakfast.entries.map((e) => e.name), ['Import Oats']);

    // replace: warned, offers an export first; deletes the own rows, then imports the file
    await api('PUT', `water/${today()}`, { ml: 1234 });
    await card.locator('input[type=file]').setInputFiles({ name: 'mahlwerk-export.zip', mimeType: 'application/zip', buffer: await import('node:fs').then((fs) => fs.readFileSync(file)) });
    await preview.getByRole('radio', { name: 'Replace' }).click();
    await preview.getByText(/Deletes all your data here/).waitFor();
    await preview.getByRole('link', { name: 'Export the current state first' }).waitFor();
    await preview.getByRole('button', { name: /Replace: Import now/ }).click();
    await page.getByTestId('import-done').getByText(/old rows were deleted first/).waitFor();
    const after = await api('GET', `diary/${today()}`);
    assert.equal(after.water.ml, 0, 'the water of today was not in the file');
    assert.deepEqual(after.meals.breakfast.entries.map((e) => e.name), ['Import Oats']);
  });
});
