import test from 'node:test';
import assert from 'node:assert/strict';
import * as fi from '../src/lib/foodImage.ts';

test('picture addresses are relative server paths by content hash and size', () => {
  const h = 'a'.repeat(32);
  assert.equal(fi.imageUrl(h, 'l'), `api/v1/images/${h}/l`);
  assert.equal(fi.imageUrl(h, 's'), `api/v1/images/${h}/s`);
  fi.imageRegistry.mock1 = 'data:image/svg+xml;utf8,x';
  assert.equal(fi.imageUrl('mock1', 'm'), 'data:image/svg+xml;utf8,x');
});
test('only a provider picture carries a credit', () => {
  assert.equal(fi.imageCredit({ hash: 'x', origin: 'cookidoo', credit: 'Cookidoo' }), 'Cookidoo');
  assert.equal(fi.imageCredit({ hash: 'x', origin: 'web', credit: 'recipes.example.org' }), 'recipes.example.org');
  assert.equal(fi.imageCredit({ hash: 'x', origin: 'own', credit: 'whatever' }), null);
  assert.equal(fi.imageCredit(null), null);
});
test('the stand-in shows a whole first character', () => {
  assert.equal(fi.initial('ärger'), 'Ä');
  assert.equal(fi.initial('  pasta'), 'P');
  assert.equal(fi.initial('🍝 Pasta'), '🍝');
  assert.equal(fi.initial(''), '');
  assert.equal(fi.initial(null), '');
  assert.equal(fi.hasImage({ image: null }), false);
  assert.equal(fi.hasImage({ image: { hash: 'h', origin: 'own', credit: null } }), true);
});
