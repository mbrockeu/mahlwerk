import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Access, CookidooError, MESSAGES, RecipeRejected, Settings, foodData, nutritionFrom, recipeId, recipeUrl } from '../core/cookidoo.ts';
import { LENTILS, entry } from './cookidooHarness.ts';

test('the test runner finds this file', () => assert.ok(true));

test('recipe id from an id or a link, and nothing else', () => {
  const ok: [string, string][] = [['r59322', 'r59322'], ['  r100001 ', 'r100001'], ['https://cookidoo.de/recipes/recipe/de-DE/r59322', 'r59322'],
    ['https://cookidoo.de/recipes/recipe/de-DE/r59322/', 'r59322'], ['https://cookidoo.de/recipes/recipe/de-DE/r59322?utm_source=share', 'r59322'],
    ['https://www.cookidoo.co.uk/recipes/recipe/en-GB/r123456#x', 'r123456'], ['https://cookidoo.thermomix.com/recipes/recipe/en/r123456', 'r123456'],
    ['https://cookidoo.ch/recipes/recipe/r123456', 'r123456']];
  for (const [text, id] of ok) assert.equal(recipeId(text), id, text);
  const bad = ['', '59322', 'R59322', 'r12', 'r12345678901', 'r5932x', '../r59322', 'r59322/../x', 'http://cookidoo.de/recipes/recipe/de-DE/r59322',
    'https://evil.example/recipes/recipe/de-DE/r59322', 'https://cookidoo.de.evil.example/recipes/recipe/de-DE/r59322',
    'https://evil.example/?u=https://cookidoo.de/recipes/recipe/de-DE/r59322', 'https://user@cookidoo.de/recipes/recipe/de-DE/r59322',
    'https://cookidoo.de:8443/recipes/recipe/de-DE/r59322', 'https://cookidoo.de/recipes/recipe/de-DE/r59322\nhttps://evil.example',
    'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd'];
  for (const text of bad) assert.equal(recipeId(text), null, JSON.stringify(text));
  assert.equal(recipeId(null), null);
});

test('conversion of a full recipe: sodium becomes salt, unknown stays unknown', () => {
  const [per100, extra] = nutritionFrom(LENTILS.nutrition);
  assert.deepEqual(per100, { kcal: 497.0, fat: 8.0, saturated_fat: 5.0, carbs: 73.0, sugars: null, fiber: 12.2, protein: 37.0, salt: 2.92 });
  assert.deepEqual(extra, { sodium: 1168.0 });
});

test('energy falls back to kilojoules; units are converted and odd ones ignored', () => {
  const [a] = nutritionFrom(entry({ kJ: [2092, 'kJ'] }));
  assert.equal(a.kcal, 500.0);
  assert.equal(a.fat, null);
  const [b, extra] = nutritionFrom(entry({ kcal: [100, 'kcal'], protein: [5000, 'mg'], fat: [3, 'furlong'], sodium: [1, 'g'] }));
  assert.equal(b.protein, 5.0);
  assert.equal(b.fat, null);
  assert.deepEqual(extra, { sodium: 1000.0 });
});

test('implausible values are dropped or refuse; no energy or no portion block is refused', () => {
  assert.equal(nutritionFrom(entry({ kcal: [100, 'kcal'], fat: [9000, 'g'] }))[0].fat, null);
  assert.throws(() => nutritionFrom(entry({ kcal: [99999, 'kcal'] })), RecipeRejected);
  assert.throws(() => nutritionFrom(entry({ protein: [5, 'g'] })), /energy/);
  assert.throws(() => nutritionFrom(entry({ kcal: [100, 'kcal'] }, 100)), /per portion/);
  assert.throws(() => nutritionFrom([]), RecipeRejected);
  assert.throws(() => nutritionFrom(entry({ kcal: [-1, 'kcal'] })), /energy/);
});

test('the food is booked as one portion of 100 g', () => {
  const data = foodData(LENTILS);
  assert.equal(data.name, 'Red lentil salad');
  assert.equal(data.unit, 'g');
  assert.equal(data.serving_quantity, 100.0);
  assert.equal(data.serving_size, '1 portion');
  assert.equal(data.portions, 4.0);
  assert.equal(data.complete, true);
  assert.equal(foodData({ id: 'r1', name: 'X', portions: null, nutrition: entry({ kcal: [10, 'kcal'] }) }).complete, false);
  assert.throws(() => foodData({ id: 'r1', name: '  ', portions: 1, nutrition: entry({ kcal: [10, 'kcal'] }) }), /name/);
});

test('settings: validation, defaults, and no secret in any text form', () => {
  const env = { MAHLWERK_COOKIDOO_EMAIL: 'someone@example.invalid' };
  assert.equal(Settings.fromEnv({}), null);
  assert.equal(Settings.fromEnv(env), null); // the password is missing
  const s = Settings.fromEnv({ ...env, MAHLWERK_COOKIDOO_PASSWORD: 'hunter2-not-real' })!;
  assert.deepEqual([s.country, s.language], ['de', 'de-DE']);
  for (const text of [String(s), JSON.stringify(s), JSON.stringify({ s }), `${s}`, JSON.stringify(new Access('shared', s, 'shared')), String(new Access('shared', s, 'shared'))]) {
    assert.ok(!text.includes('hunter2') && !text.includes('someone@'), text);
  }
  const util = require_inspect(s);
  assert.ok(!util.includes('hunter2') && !util.includes('someone@'));
  const full = { MAHLWERK_COOKIDOO_EMAIL: 'a@b.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'x' };
  assert.equal(Settings.fromEnv({ ...full, MAHLWERK_COOKIDOO_COUNTRY: 'Germany' }), null);
  assert.equal(Settings.fromEnv({ ...full, MAHLWERK_COOKIDOO_COUNTRY: 'CH', MAHLWERK_COOKIDOO_LANGUAGE: 'de-CH' })!.country, 'ch');
  assert.equal(Settings.fromEnv({ ...full, MAHLWERK_COOKIDOO_LANGUAGE: 'de_CH' }), null);
  assert.equal(Settings.fromEnv({ ...full, MAHLWERK_COOKIDOO_LANGUAGE: 'de-DEX' }), null); // the whole text must match
  assert.equal(Settings.build('a@b.invalid\nx', 'pw', 'de', 'de-DE'), null);
  assert.equal(Settings.build('a'.repeat(201), 'pw', 'de', 'de-DE'), null);
  assert.equal(Settings.build('a@b.invalid', 'p'.repeat(501), 'de', 'de-DE'), null);
  assert.ok(s.equals(Settings.build('someone@example.invalid', 'hunter2-not-real', 'de', 'de-DE')));
  assert.ok(!s.equals(Settings.build('someone@example.invalid', 'other', 'de', 'de-DE')));
});

import { inspect } from 'node:util';
function require_inspect(v: unknown): string { return inspect(v, { depth: 5 }); }

test('the link of a taken-over recipe is built from the region and never guessed', () => {
  const env = { MAHLWERK_COOKIDOO_EMAIL: 'a@b.invalid', MAHLWERK_COOKIDOO_PASSWORD: 'x' };
  assert.equal(recipeUrl('cookidoo:r100001', env, ['de', 'de-DE']), 'https://cookidoo.de/recipes/recipe/de-DE/r100001');
  assert.equal(recipeUrl('cookidoo:r100001', env, ['gb', 'en-GB']), 'https://cookidoo.co.uk/recipes/recipe/en-GB/r100001');
  assert.equal(recipeUrl('cookidoo:r100001', env, ['xx', 'xx-XX']), null); // unknown country
  assert.equal(recipeUrl('cookidoo:r100001', env, ['__proto__', 'de-DE']), null);
  assert.equal(recipeUrl('bls:B100000', env, ['de', 'de-DE']), null);
  assert.equal(recipeUrl('cookidoo:evil/../x', env, ['de', 'de-DE']), null);
  assert.equal(recipeUrl(null, env), null);
  assert.equal(recipeUrl('cookidoo:r100001', env), 'https://cookidoo.de/recipes/recipe/de-DE/r100001'); // the environment's region
  assert.equal(recipeUrl('cookidoo:r100001', {}), null); // not configured: no region known
});

test('every error text is neutral', () => {
  for (const kind of Object.keys(MESSAGES)) assert.equal(new CookidooError(kind).message, MESSAGES[kind]);
});
