import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INSIGHTS_HELP, INSIGHT_TABS, parseTab } from '../src/lib/help.ts';

const i18n = readFileSync(new URL('../src/lib/i18n.ts', import.meta.url), 'utf8');
const de = i18n.slice(i18n.indexOf('const de: Record<Key, string>'));
const en = i18n.slice(0, i18n.indexOf('} as const;'));
const has = (block, key) => new RegExp(`[\\s{,]${key}:\\s*['"]`).test(block);
const page = readFileSync(new URL('../src/views/Insights.svelte', import.meta.url), 'utf8');
const insights = page + readFileSync(new URL('../src/components/ReviewPanel.svelte', import.meta.url), 'utf8');

test('every help entry has its texts in both languages', () => {
  for (const e of INSIGHTS_HELP) {
    for (const key of [e.title, `hlp_${e.id}`, ...(e.needs ?? [])]) {
      assert.ok(has(en, key), `en: ${key}`);
      assert.ok(has(de, key), `de: ${key}`);
    }
  }
});

test('every jump target exists on the evaluation page', () => {
  for (const e of INSIGHTS_HELP) if (e.target) assert.ok(insights.includes(`id="${e.target}"`), e.target);
});

test('each card sits in the tab the help names', () => {
  // the markup of a tab runs from its `tab === '…'` test to the next one
  const spans = INSIGHT_TABS.map((tb) => [tb, page.indexOf(`tab === '${tb}'`)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  assert.equal(spans.length, INSIGHT_TABS.length);
  const tabAt = (pos) => { let cur = null; for (const [tb, i] of spans) if (i <= pos) cur = tb; return cur; };
  for (const e of INSIGHTS_HELP) {
    if (!e.target || e.target === 'h-review') continue;
    assert.equal(tabAt(page.indexOf(`id="${e.target}"`)), e.tab, e.id);
  }
});

test('tabs: unknown is the overview, entries are unique', () => {
  assert.equal(parseTab('body'), 'body');
  assert.equal(parseTab('x'), 'overview');
  assert.equal(parseTab(null), 'overview');
  const ids = INSIGHTS_HELP.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});
