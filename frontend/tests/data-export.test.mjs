process.env.TZ = 'Europe/Berlin';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportUrl, periodProblem } from '../src/lib/dataExport.ts';

const TODAY = '2026-11-15';

test('everything has no period, only the CSV language', () => {
  assert.equal(exportUrl('all', '', '', TODAY, 'de'), 'api/v1/me/export?lang=de');
  assert.equal(exportUrl('all', '2020-01-01', '2020-02-01', TODAY, 'en'), 'api/v1/me/export?lang=en'); // dates of a hidden custom form are ignored
});

test('the last year is 365 days ending today', () => {
  assert.equal(exportUrl('year', '', '', TODAY, 'en'), 'api/v1/me/export?from=2025-11-16&to=2026-11-15&lang=en');
  assert.equal(exportUrl('year', '', '', '2028-02-29', 'en'), 'api/v1/me/export?from=2027-03-02&to=2028-02-29&lang=en');
});

test('a custom period may leave one end open', () => {
  assert.equal(exportUrl('custom', '2026-01-01', '2026-02-01', TODAY, 'en'), 'api/v1/me/export?from=2026-01-01&to=2026-02-01&lang=en');
  assert.equal(exportUrl('custom', '2026-01-01', '', TODAY, 'de'), 'api/v1/me/export?from=2026-01-01&lang=de');
  assert.equal(exportUrl('custom', '', '2026-02-01', TODAY, 'de'), 'api/v1/me/export?to=2026-02-01&lang=de');
  assert.equal(exportUrl('custom', '', '', TODAY, 'de'), 'api/v1/me/export?lang=de');
});

test('an end before the start or a malformed day gives no link', () => {
  assert.equal(periodProblem('custom', '2026-02-01', '2026-01-01'), 'order');
  assert.equal(periodProblem('custom', '1.2.2026', ''), 'format');
  assert.equal(periodProblem('year', 'x', 'y'), null);
  assert.equal(exportUrl('custom', '2026-02-01', '2026-01-01', TODAY, 'en'), null);
  assert.equal(exportUrl('custom', 'abc', '', TODAY, 'en'), null);
});
