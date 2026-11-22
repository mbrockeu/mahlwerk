import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyPoints, bodyChange } from '../src/lib/body.ts';

test('fat and lean mass come from kg and percent, a lean mass alone gives the percent', () => {
  const pts = bodyPoints([
    { day: '2026-01-01', kg: 80, body_fat_pct: 25 },
    { day: '2026-01-02', kg: 80 },
    { day: '2026-01-03', kg: 80, lean_kg: 60 },
    { day: '2026-01-04', kg: 80, body_fat_pct: 20, lean_kg: 50 },
  ]);
  assert.deepEqual(pts, [
    { day: '2026-01-01', pct: 25, fat: 20, lean: 60 },
    { day: '2026-01-03', pct: 25, fat: 20, lean: 60 },
    { day: '2026-01-04', pct: 20, fat: 16, lean: 64 },
  ]);
});

test('the change looks back from the latest value to the newest one on or before the cutoff', () => {
  const s = bodyPoints([
    { day: '2026-01-01', kg: 80, body_fat_pct: 25 },
    { day: '2026-01-08', kg: 80, body_fat_pct: 24 },
    { day: '2026-01-15', kg: 80, body_fat_pct: 23 },
  ]);
  assert.equal(bodyChange(s, 'pct', '2026-01-08'), -1);
  assert.equal(bodyChange(s, 'fat', '2026-01-01'), -1.6);
  assert.equal(bodyChange(s, 'pct', '2025-12-01'), null);
  assert.equal(bodyChange([], 'pct', '2026-01-08'), null);
  assert.equal(bodyChange(s.slice(0, 1), 'pct', '2026-01-08'), null);
});
