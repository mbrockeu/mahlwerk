import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { launch, withPage, apiClient, today, food } from '../lib.mjs';

let browser; const api = apiClient();
before(async () => {
  browser = await launch();
  await api('PATCH', 'me/settings', { tour_seen: true });
  const oats = await api('POST', 'foods', food('Smoke Oats', 370, 13, 60, 7));
  await api('POST', `diary/${today()}/entries`, { meal: 'breakfast', food_id: oats.id, amount: 100 });
  await api('PUT', `weights/${today()}`, { kg: 78.4 });
});
after(() => browser.close());

/** name -> content of every file of a ZIP (stored or deflated), read from the central directory. */
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'not a ZIP (no end-of-directory record)');
  const files = {}; let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files[name] = method === 8 ? inflateRawSync(raw) : raw;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

test('export: the data export is a ZIP with the expected files', async () => {
  await withPage(browser, 'export', async (page) => {
    await page.goto('/#/profile/data');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download ZIP' }).click()]);
    assert.match(download.suggestedFilename(), /^mahlwerk-export-.+\.zip$/);
    const buf = readFileSync(await download.path());
    assert.equal(buf.readUInt32LE(0), 0x04034b50, 'starts with the ZIP local header');
    const files = unzip(buf);
    for (const name of ['diary.csv', 'weight.csv', 'activity.csv', 'workouts.csv', 'water.csv', 'fasting.csv', 'mahlwerk-export.json']) assert.ok(name in files, `${name} is in the ZIP (has: ${Object.keys(files)})`);
    assert.match(files['diary.csv'].toString('utf8'), /Smoke Oats/);
    assert.match(files['weight.csv'].toString('utf8'), /78\.4/);
    assert.ok(JSON.parse(files['mahlwerk-export.json'].toString('utf8')).diary, 'the JSON has a diary section');
  });
});
