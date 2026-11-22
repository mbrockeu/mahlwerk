import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLink, stripDeepLink } from '../src/lib/deeplink.ts';

test('go and meal become a tab of the add sheet', () => {
  assert.deepEqual(parseDeepLink('?go=scan'), { tab: 'scan', meal: null, photo: false });
  assert.deepEqual(parseDeepLink('?go=add&meal=breakfast'), { tab: 'search', meal: 'breakfast', photo: false });
  assert.deepEqual(parseDeepLink('?go=recent&meal=snack'), { tab: 'recent', meal: 'snack', photo: false });
  assert.deepEqual(parseDeepLink('?go=templates&meal=brunch'), { tab: 'templates', meal: null, photo: false });
});

test('photo opens the search tab with the meal photo', () => {
  assert.deepEqual(parseDeepLink('?go=photo'), { tab: 'search', meal: null, photo: true });
  assert.deepEqual(parseDeepLink('?go=photo&meal=dinner'), { tab: 'search', meal: 'dinner', photo: true });
  assert.equal(stripDeepLink('?go=photo&meal=dinner'), '');
});

test('no or unknown go is no direct link', () => {
  assert.equal(parseDeepLink(''), null);
  assert.equal(parseDeepLink('?go=cookidoo'), null);
  assert.equal(parseDeepLink('?meal=lunch'), null);
});

test('stripping keeps other parameters', () => {
  assert.equal(stripDeepLink('?go=scan'), '');
  assert.equal(stripDeepLink('?go=add&meal=lunch&engine=zxing'), '?engine=zxing');
});
