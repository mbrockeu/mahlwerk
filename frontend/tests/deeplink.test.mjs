import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLink, stripDeepLink } from '../src/lib/deeplink.ts';

test('go and meal become a tab of the add sheet', () => {
  assert.deepEqual(parseDeepLink('?go=scan'), { tab: 'scan', meal: null });
  assert.deepEqual(parseDeepLink('?go=add&meal=breakfast'), { tab: 'search', meal: 'breakfast' });
  assert.deepEqual(parseDeepLink('?go=recent&meal=snack'), { tab: 'recent', meal: 'snack' });
  assert.deepEqual(parseDeepLink('?go=templates&meal=brunch'), { tab: 'templates', meal: null });
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
