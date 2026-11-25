// Readers of untrusted text outside the web recipes: Python's strip() (used on names, lines and fields from files and requests) and
// the request id of the Cookidoo login page. Both must stay linear on crafted input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestIdOf } from '../core/cookidooClient.ts';
import { pySplit, pyStrip } from '../core/text.ts';

const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const value = f();
  return [value, performance.now() - t];
};

test('strip() is linear on a long inner run of blanks and keeps Python\'s whitespace', () => {
  const [stripped, ms] = timed(() => pyStrip(' x' + ' 　\x1c'.repeat(300_000) + 'y\x85 '));
  assert.ok(ms < 200, `${Math.round(ms)} ms`);
  assert.equal(stripped.length, 2 + 900_000);
  const [words, ms2] = timed(() => pySplit('a' + ' '.repeat(500_000) + 'b'));
  assert.ok(ms2 < 200, `${Math.round(ms2)} ms`);
  assert.deepEqual(words, ['a', 'b']);
  assert.equal(pyStrip('\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0       　 a b 　'), 'a b');
  assert.equal(pyStrip('﻿a﻿'), '﻿a﻿'); // the BOM is no whitespace in Python
  assert.equal(pyStrip(''), '');
  assert.equal(pyStrip('   '), '');
});

test('the request id of the Cookidoo login form, also on a crafted page', () => {
  const id = '0123abcd-0000-4000-8000-00000000abcd';
  assert.equal(requestIdOf(`<form><input type="hidden" name="requestId" value="${id}"></form>`), id);
  assert.equal(requestIdOf(`<input type="text" name="x"><input value='${id}' type=hidden name='requestId'/>`), id);
  assert.equal(requestIdOf('<input name="requestId">'), null);
  assert.equal(requestIdOf('<input name="other" value="1">'), null);
  for (const page of ['<input '.repeat(60_000), '<input ' + 'name="requestId" '.repeat(20_000) + '>', '<input ' + `value="${id}" `.repeat(10_000) + '>']) {
    const [found, ms] = timed(() => requestIdOf(page));
    assert.equal(found, null);
    assert.ok(ms < 200, `${Math.round(ms)} ms`);
  }
});
