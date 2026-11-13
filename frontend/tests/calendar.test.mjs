import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/lib/calendarGrid.ts';

const run = (from, n, state = 'in_range') => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000);
  return { day: d.toISOString().slice(0, 10), state };
});
const days = (row) => row.map((x) => (x ? x.day.slice(8) : '--')).join(' ');

test('mode: months up to eight weeks, week columns beyond', () => {
  for (const n of [1, 7, 30, 56]) assert.equal(c.calendarMode(n), 'months');
  for (const n of [57, 90, 365, 370]) assert.equal(c.calendarMode(n), 'weeks');
});

test('week days: Monday and Sunday start, leap day, year change', () => {
  assert.equal(c.weekdayIndex('2026-11-09'), 0); // Monday
  assert.equal(c.weekdayIndex('2026-11-15'), 6); // Sunday
  assert.equal(c.weekdayIndex('2026-11-15', 0), 0);
  assert.equal(c.weekdayIndex('2024-02-29'), 3); // Thursday
  assert.equal(c.startOfWeek('2027-01-01'), '2026-12-28'); // Friday over the new year
  assert.equal(c.startOfWeek('2026-11-15', 0), '2026-11-15');
});

test('month block: a month starting in mid-week gets blank squares, a period starting mid-month dims the earlier days', () => {
  const [blk] = c.monthBlocks(run('2026-10-01', 31)); // 1 Oct 2026 is a Thursday
  assert.equal(blk.month, '2026-10');
  assert.equal(days(blk.weeks[0]), '-- -- -- 01 02 03 04');
  assert.equal(blk.weeks.length, 5);
  assert.equal(days(blk.weeks[4]), '26 27 28 29 30 31 --');
  const [oct, nov] = c.monthBlocks(run('2026-10-14', 30));
  assert.equal(oct.month, '2026-10');
  assert.equal(nov.month, '2026-11');
  assert.equal(oct.weeks.length, 3); // the weeks of 1 to 11 Oct have no day in the period and are left out
  assert.equal(days(oct.weeks[0]), '12 13 14 15 16 17 18'); // 12 and 13 are shown, but outside the period
  assert.equal(oct.weeks[0][0].inPeriod, false);
  assert.equal(oct.weeks[0][2].inPeriod, true);
  assert.equal(days(oct.weeks[2]), '26 27 28 29 30 31 --');
  assert.equal(days(nov.weeks[0]), '-- -- -- -- -- -- 01');
  assert.equal(nov.weeks[1][0].day, '2026-11-02');
  assert.equal(nov.weeks.at(-1).at(-1).inPeriod, false); // Sun 15 Nov: after the last day, shown dimmed
});

test('month block: Sunday start moves the columns', () => {
  const [blk] = c.monthBlocks(run('2026-11-01', 30), 0); // 1 Nov 2026 is a Sunday
  assert.equal(days(blk.weeks[0]), '01 02 03 04 05 06 07');
  const [mon] = c.monthBlocks(run('2026-11-01', 30), 1);
  assert.equal(days(mon.weeks[0]), '-- -- -- -- -- -- 01');
});

test('month blocks over the year change and in a leap year', () => {
  const blocks = c.monthBlocks(run('2026-12-20', 20));
  assert.deepEqual(blocks.map((b) => b.month), ['2026-12', '2027-01']);
  assert.equal(blocks[1].weeks[0].find(Boolean).day, '2027-01-01');
  const feb = c.monthBlocks(run('2024-02-01', 29))[0];
  assert.equal(feb.weeks.flat().filter(Boolean).length, 29); // 2024 is a leap year
  assert.equal(feb.weeks.at(-1).find((x) => x?.day === '2024-02-29')?.inPeriod, true);
  assert.equal(c.monthBlocks(run('2025-02-01', 28))[0].weeks.flat().filter(Boolean).length, 28);
  assert.equal(c.monthBlocks(run('2023-12-31', 3)).length, 2); // 31 Dec, 1 and 2 Jan
});

test('daylight saving changes do not move or lose a day', () => {
  // European and US clock changes lie inside these runs; every day must appear exactly once
  for (const [from, n] of [['2026-03-20', 20], ['2026-10-20', 20], ['2026-03-01', 20], ['2026-11-01', 10]]) {
    const cal = run(from, n);
    const seen = c.monthBlocks(cal).flatMap((b) => b.weeks.flat()).filter((x) => x?.inPeriod).map((x) => x.day);
    assert.deepEqual(seen, cal.map((x) => x.day));
    const weeks = c.weekColumns(cal).weeks.flat().filter(Boolean).map((x) => x.day);
    assert.deepEqual(weeks, cal.map((x) => x.day));
  }
});

test('gaps in the data become "nothing logged", the order of the input does not matter', () => {
  const cal = [{ day: '2026-11-12', state: 'over' }, { day: '2026-11-09', state: 'in_range' }];
  const [blk] = c.monthBlocks(cal);
  const cells = blk.weeks.flat().filter((x) => x?.inPeriod);
  assert.deepEqual(cells.map((x) => [x.day.slice(8), x.state]), [['09', 'in_range'], ['10', 'none'], ['11', 'none'], ['12', 'over']]);
  assert.deepEqual(c.monthBlocks([]), []);
  assert.deepEqual(c.weekColumns([]), { weeks: [], marks: [], starts: [] });
});

test('week columns: padding is empty, columns count the weeks, month marks sit on the 1st', () => {
  const w = c.weekColumns(run('2026-10-14', 30)); // Wed 14 Oct to Thu 12 Nov
  assert.equal(w.weeks.length, 5);
  assert.equal(days(w.weeks[0]), '-- -- 14 15 16 17 18');
  assert.equal(days(w.weeks[4]), '09 10 11 12 -- -- --');
  assert.deepEqual(w.marks, [{ col: 0, month: '2026-10', yearChanged: false }, { col: 2, month: '2026-11', yearChanged: false }]);
  assert.deepEqual(w.starts, [{ col: 2, row: 6 }]); // 1 Nov is a Sunday in the third week
});

test('week columns over a year: year change flagged, whole year in 53 or 54 columns', () => {
  const w = c.weekColumns(run('2026-01-01', 365));
  assert.equal(w.weeks.length, 53);
  assert.equal(w.marks.length, 12);
  assert.equal(w.marks[0].col, 0);
  const across = c.weekColumns(run('2026-06-01', 370));
  assert.equal(across.marks.find((m) => m.month === '2027-01')?.yearChanged, true);
  assert.equal(across.marks.filter((m) => m.yearChanged).length, 1);
  assert.equal(across.weeks.flat().filter(Boolean).length, 370);
  // a month starting on a Monday has no step in its boundary
  assert.deepEqual(c.weekColumns(run('2026-06-29', 10)).starts, [{ col: 0, row: 2 }]);
  assert.deepEqual(c.weekColumns(run('2026-12-28', 10)).starts, [{ col: 0, row: 4 }]);
});

test('tally counts the states once per day', () => {
  const cal = [...run('2026-11-01', 3, 'in_range'), ...run('2026-11-04', 2, 'under'), { day: '2026-11-06', state: 'over' }, { day: '2026-11-07', state: 'none' }, { day: '2026-11-07', state: 'none' }];
  assert.deepEqual(c.tally(cal), { total: 7, in_range: 3, under: 2, over: 1, no_goal: 0, none: 1, logged: 6 });
});

test('arrow keys: months step by day and week, week columns the other way round, clamped to the period', () => {
  assert.equal(c.arrowDay('ArrowRight', false, '2026-11-10', '2026-11-01', '2026-11-30'), '2026-11-11');
  assert.equal(c.arrowDay('ArrowDown', false, '2026-11-10', '2026-11-01', '2026-11-30'), '2026-11-17');
  assert.equal(c.arrowDay('ArrowDown', true, '2026-11-10', '2026-11-01', '2026-11-30'), '2026-11-11');
  assert.equal(c.arrowDay('ArrowLeft', true, '2026-11-10', '2026-11-01', '2026-11-30'), '2026-11-03');
  assert.equal(c.arrowDay('ArrowUp', false, '2026-11-03', '2026-11-01', '2026-11-30'), '2026-11-01');
  assert.equal(c.arrowDay('ArrowRight', false, '2026-11-30', '2026-11-01', '2026-11-30'), '2026-11-30');
  assert.equal(c.arrowDay('Home', false, '2026-11-10', '2026-11-01', '2026-11-30'), '2026-11-01');
  assert.equal(c.arrowDay('End', true, '2026-11-10', '2026-11-01', '2026-11-30'), '2026-11-30');
  assert.equal(c.arrowDay('x', true, '2026-11-10', '2026-11-01', '2026-11-30'), null);
  assert.equal(c.arrowDay('ArrowDown', false, '2026-12-30', '2026-12-01', '2027-01-15'), '2027-01-06'); // over the year change
});
