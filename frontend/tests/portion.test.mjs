import test from 'node:test';
import assert from 'node:assert/strict';

// portion.ts uses the texts (i18n.ts), which read the language from the browser when they load
globalThis.document ??= { documentElement: {} };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { isPortionEntry, sourceLabel, webHost } = await import('../src/lib/portion.ts');

test('the host of a web recipe comes from its brand; a brand that is no text is no host, not an error', () => {
  assert.equal(webHost({ source: 'web', brand: 'Web · example.org' }), 'example.org');
  assert.equal(webHost({ source: 'web', brand: null }), null);
  assert.equal(webHost({ source: 'web', brand: { a: 1 } }), null);
  assert.equal(webHost({ source: 'web', brand: 42 }), null);
  assert.equal(sourceLabel({ source: 'web', brand: ['Web · x'] }), null);
  assert.equal(isPortionEntry({ brand: { a: 1 }, unit: 'g' }), false);
  assert.equal(isPortionEntry({ brand: 'Cookidoo', unit: 'g' }), true);
});
