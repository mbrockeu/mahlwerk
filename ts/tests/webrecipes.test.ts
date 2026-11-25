// The reader of fetched recipe pages (core/webrecipes.ts) on untrusted text: crafted pages of the largest allowed size (3 MB unpacked)
// are read in linear time, so one page cannot block the single Node process. The normal reading is covered by the Python API tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBlocked, parsePage } from '../core/webrecipes.ts';

const MB3 = 3 * 1024 * 1024;
const fill = (unit: string) => unit.repeat(Math.floor(MB3 / unit.length));
const LD = '<script type="application/ld+json">{"@type":"Recipe","name":"Soup","nutrition":{"calories":"300 kcal"}}</script>';

const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const value = f();
  return [value, performance.now() - t];
};

test('a crafted 3 MB page is read in well under a second', () => {
  const pages: Record<string, string> = {
    'script tags without >': LD + fill('<script '),
    'empty script tags': LD + fill('<script></script>'),
    'open comments': LD + fill('<!--'),
    'many comments': LD + fill('<!-- -->'),
    'a type attribute without its quote': LD + '<script ' + fill(' type="') + '>',
    'unclosed ld+json blocks': LD + fill('<script type="application/ld+json">{'),
    'lists of lists': '<script type="application/ld+json">[' + Array(1000).fill('[' + Array(500).fill('1').join(',') + ']').join(',') + ']</script>',
  };
  for (const [name, page] of Object.entries(pages)) {
    assert.ok(page.length > MB3 - 64 || name === 'lists of lists', name);
    const [parsed, ms] = timed(() => parsePage(page));
    assert.ok(ms < 1000, `${name}: ${Math.round(ms)} ms`);
    if (page.startsWith(LD)) assert.equal(parsed?.name, 'Soup', name);
  }
});

test('the reader still finds blocks after comments and other scripts, and skips commented-out ones', () => {
  const page = '<html><!-- <script type="application/ld+json">{"@type":"Recipe","name":"Hidden"}</script> -->'
    + '<script src="a.js"></script><SCRIPT TYPE=\'application/ld+json; charset=utf-8\'>{"@type":"Recipe","name":"Shown"}</SCRIPT>';
  assert.equal(parsePage(page)?.name, 'Shown');
  assert.equal(parsePage('<script type="application/ld+json">{"@type":"Recipe","name":"Open"}')?.name, 'Open'); // no end tag: the block runs to the end
  assert.equal(parsePage('<script type="application/ld+json"{"@type":"Recipe","name":"Open"}'), null); // the tag never ends
  assert.equal(parsePage('<script type="application/ld+json">{"@type":"Recipe","name":"Open"}</script')?.name, 'Open');
});

test('a long run of trailing dots in a redirect host is cheap', () => {
  const [blocked, ms] = timed(() => isBlocked('.'.repeat(200_000) + 'x' + '.'.repeat(200_000), ['example.org']));
  assert.equal(blocked, false);
  assert.ok(ms < 200, `${Math.round(ms)} ms`);
  assert.equal(isBlocked('Sub.Example.org...', ['example.org']), true);
});
