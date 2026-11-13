// ISO weeks must not depend on daylight saving time: run in a zone that has it.
process.env.TZ = 'Europe/Berlin';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isoWeek, mondayOfWeek, shiftDay } = await import('../src/lib/day.ts');

test('ISO week in summer and winter time', () => {
  assert.equal(isoWeek('2026-10-19'), '2026-W43'); // summer time
  assert.equal(isoWeek('2026-10-26'), '2026-W44'); // the week after the clocks went back
  assert.equal(isoWeek('2026-07-02'), '2026-W27');
  assert.equal(isoWeek('2026-01-01'), '2026-W01');
  assert.equal(isoWeek('2027-01-03'), '2026-W53');
  assert.equal(isoWeek('2024-12-30'), '2025-W01');
});

test('stepping through a whole year week by week comes back the same way', () => {
  let monday = '2026-01-05';
  for (let i = 0; i < 60; i++) {
    const week = isoWeek(monday);
    assert.equal(mondayOfWeek(week), monday, week);
    const next = shiftDay(monday, 7);
    assert.notEqual(isoWeek(next), week);
    assert.equal(shiftDay(mondayOfWeek(isoWeek(next)), -7), monday);
    monday = next;
  }
});
