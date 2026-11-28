// The goal on chosen weekdays ("an bestimmten Tagen anders"): the timeline decides per day, PUT /me/goal keeps, removes or sets the
// schedule, it is validated, it shows in /me and the history, it travels through the data export and import.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SINCE_START, goalOn, makeTimeline, period, current, currentSchedule, weekdayBit, maskOf, weekdaysOf, type GoalValues } from '../core/goals.ts';
import { goalOn as storeGoalOn, goalTimeline, setGoal } from '../core/store/goals.ts';
import { unzip } from '../core/yazioStage.ts';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) await w.close(); });
const world = async () => { const w = await makeWorld({ on: false }); worlds.push(w); return w; };

const base = (kcal: number, protein = 100): GoalValues => ({ kcal, protein, carbs: 250, fat: 70, water_ml: 2000, steps: 8000 });
const MASK_SASO = maskOf([6, 7]);
const MASK_FRSASO = maskOf([5, 6, 7]);

test('the weekday of a date is computed without a time zone: 2026-03-02 is a Monday', () => {
  assert.deepEqual(['2026-03-02', '2026-03-03', '2026-03-07', '2026-03-08', '2026-03-09'].map(weekdayBit), [0, 1, 5, 6, 0]);
  assert.equal(weekdayBit('2024-02-29'), 3); // a leap day, Thursday
  assert.equal(weekdayBit(SINCE_START), 0); // 0001-01-01 was a Monday
  assert.deepEqual(weekdaysOf(maskOf([7, 1, 5])), [1, 5, 7]);
});

test('goalOn takes the alternative values on the chosen weekdays and each history row keeps its own schedule', () => {
  const tl = makeTimeline([
    [SINCE_START, base(2000)],
    ['2026-03-02', base(2000), { days: MASK_SASO, kcal: 2500, protein: 130, carbs: 300, fat: 90 }],
    ['2026-03-16', base(1800, 110), { days: MASK_FRSASO, kcal: 2200, protein: 120, carbs: 260, fat: 80 }],
  ]);
  const kcal = (d: string) => goalOn(tl, d).kcal;
  assert.equal(kcal('2026-02-28'), 2000); // a Saturday before the first schedule: the goal it had
  assert.equal(kcal('2026-03-06'), 2000); // Friday, not yet in the schedule
  assert.equal(kcal('2026-03-07'), 2500); // Saturday
  assert.equal(kcal('2026-03-08'), 2500); // Sunday
  assert.equal(kcal('2026-03-09'), 2000); // Monday
  assert.equal(kcal('2026-03-14'), 2500); // still the old schedule the day before the change
  assert.equal(kcal('2026-03-20'), 2200); // Friday under the new schedule
  assert.equal(kcal('2026-03-23'), 1800); // Monday under the new base
  assert.deepEqual(goalOn(tl, '2026-03-07'), { kcal: 2500, protein: 130, carbs: 300, fat: 90, water_ml: 2000, steps: 8000 }); // water and steps stay
  assert.equal(goalOn(tl, '2026-03-21').protein, 120);
  assert.equal(current(tl).kcal, 1800); // the base goal
  assert.equal(currentSchedule(tl)?.kcal, 2200);
  // the mean of a week with its weekend: 5 x 2000 + 2 x 2500 over 7 days
  const week = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'];
  assert.equal(period(tl, week).kcal, Math.round(((5 * 2000 + 2 * 2500) / 7) * 10) / 10);
});

test('a timeline without a schedule is the plain one', () => {
  const tl = makeTimeline([[SINCE_START, base(2000)]]);
  assert.equal(tl.schedules, undefined);
  assert.equal(goalOn(tl, '2026-03-07').kcal, 2000);
  assert.equal(currentSchedule(tl), null);
});

const put = (w: World, body: unknown) => w.ann.put('/api/v1/me/goal', body);
const GOAL = { kcal: 2000, protein: 100, carbs: 250, fat: 70 };
const DAYS = { weekdays: [6, 7], kcal: 2500, protein: 130, carbs: 300, fat: 90 };

test('PUT /me/goal: left out keeps the weekday goal, null removes it, an object sets it', async () => {
  const w = await world();
  assert.equal((await put(w, GOAL)).json.days_goal, undefined); // nothing set: the field is not there
  const set = await put(w, { ...GOAL, days_goal: { ...DAYS, weekdays: [7, 6] } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json.days_goal, DAYS); // sorted
  assert.deepEqual((await w.ann.get('/api/v1/me')).json.goal.days_goal, DAYS);
  // an older app saves the goal without the field: the weekday goal stays
  const keep = await put(w, { ...GOAL, kcal: 1900 });
  assert.equal(keep.status, 200);
  assert.deepEqual(keep.json.days_goal, DAYS);
  assert.equal((await w.ann.get('/api/v1/me')).json.goal.kcal, 1900);
  assert.deepEqual((await w.ann.get('/api/v1/me')).json.goal.days_goal, DAYS);
  // a day of the schedule reads the alternative values, others the normal ones
  const rows = await w.ctx.db.all("SELECT valid_from FROM goal_history");
  assert.equal(rows.length, 1); // one row per day: the saves above are one day
  const tl = (await goalTimeline(w.ctx.db, 1))!;
  assert.equal(goalOn(tl, '2026-03-07').kcal, 2500);
  assert.equal(goalOn(tl, '2026-03-09').kcal, 1900);
  assert.equal((await w.ann.get('/api/v1/diary/2026-03-07')).json.goal.kcal, 2500);
  assert.equal((await w.ann.get('/api/v1/diary/2026-03-09')).json.goal.kcal, 1900);
  assert.equal((await w.ann.get('/api/v1/diary/2026-03-07')).json.goal.water_ml, 2000);
  // null removes it
  const off = await put(w, { ...GOAL, days_goal: null });
  assert.equal(off.json.days_goal, undefined);
  assert.equal((await w.ann.get('/api/v1/me')).json.goal.days_goal, undefined);
  assert.equal((await w.ann.get('/api/v1/diary/2026-03-07')).json.goal.kcal, 2000);
  // and the water and steps goals are not touched by any of it
  await put(w, { ...GOAL, water_ml: 2500, steps: 9000, days_goal: DAYS });
  await put(w, { ...GOAL });
  const me = (await w.ann.get('/api/v1/me')).json.goal;
  assert.deepEqual([me.water_ml, me.steps, me.days_goal], [2500, 9000, DAYS]);
});

test('the weekday goal is checked like the normal goal', async () => {
  const w = await world();
  const bad = async (days_goal: unknown) => { const r = await put(w, { ...GOAL, days_goal }); assert.equal(r.status, 422, JSON.stringify(days_goal)); };
  await bad({ ...DAYS, weekdays: [] });
  await bad({ ...DAYS, weekdays: [1, 2, 3, 4, 5, 6, 7] }); // all seven is no exception any more
  await bad({ ...DAYS, weekdays: [6, 6] });
  await bad({ ...DAYS, weekdays: [0, 6] });
  await bad({ ...DAYS, weekdays: [6, 8] });
  await bad({ ...DAYS, weekdays: [1.5] });
  await bad({ ...DAYS, weekdays: 6 });
  await bad({ ...DAYS, kcal: 499 });
  await bad({ ...DAYS, kcal: 10001 });
  await bad({ ...DAYS, protein: -1 });
  await bad({ ...DAYS, carbs: 1001 });
  await bad({ ...DAYS, fat: 'x' });
  await bad({ weekdays: [6] }); // the values are needed
  await bad('yes');
  assert.equal((await put(w, { ...GOAL, days_goal: { ...DAYS, weekdays: [1, 2, 3, 4, 5, 6] } })).status, 200); // six are fine
  assert.equal((await put(w, { ...GOAL, days_goal: { ...DAYS, weekdays: [3] } })).status, 200);
  assert.equal((await w.ann.get('/api/v1/me')).json.goal.days_goal.weekdays.length, 1); // a refused PUT changed nothing before it
  assert.equal((await put(w, { ...GOAL, days_goal: { ...DAYS, weekdays: [] } })).status, 422);
  assert.deepEqual((await w.ann.get('/api/v1/me')).json.goal.days_goal.weekdays, [3]);
});

test('a change counts from today on: the history keeps the schedule of every day', async () => {
  const w = await world();
  const db = w.ctx.db;
  await put(w, GOAL); // creates the user
  const uid = (await db.get<any>("SELECT id FROM user WHERE username = 'ann'"))!.id;
  const alt = (kcal: number, weekdays: number[]) => ({ days: maskOf(weekdays), kcal, protein: 130, carbs: 300, fat: 90 });
  await setGoal(db, uid, base(2000), '2026-03-01', 1, alt(2500, [6, 7]));
  await setGoal(db, uid, base(2000), '2026-03-10', 2, undefined); // keeps the schedule
  await setGoal(db, uid, base(1800), '2026-03-20', 3, alt(2300, [5, 6, 7]));
  await setGoal(db, uid, base(1800), '2026-03-25', 4, null); // off from here
  const on = async (d: string) => (await storeGoalOn(db, uid, d))!.kcal;
  assert.deepEqual([await on('2026-03-07'), await on('2026-03-14'), await on('2026-03-13')], [2500, 2500, 2000]);
  assert.deepEqual([await on('2026-03-21'), await on('2026-03-22'), await on('2026-03-23')], [2300, 2300, 1800]);
  assert.deepEqual([await on('2026-03-27'), await on('2026-03-28')], [1800, 1800]); // Fri/Sat after it was removed
  assert.deepEqual([await on('2026-03-18'), await on('2026-03-20')], [2000, 2300]);
  assert.equal(await on('2026-03-19'), 2000); // Thursday, before the new schedule
  assert.equal(await on('2026-03-20'), 2300); // Friday, the day it starts
  const history = (await w.ann.get('/api/v1/me/goal/history')).json;
  assert.ok(history.length >= 3);
  const row = (d: string) => history.find((h: any) => h.valid_from === d);
  assert.deepEqual(row('2026-03-10').days_goal, { weekdays: [6, 7], kcal: 2500, protein: 130, carbs: 300, fat: 90 });
  assert.deepEqual(row('2026-03-20').days_goal.weekdays, [5, 6, 7]);
  assert.equal(row('2026-03-25').days_goal, undefined);
  // the diary of a past Saturday still shows what it had then, the current setting is the newest row
  assert.equal((await w.ann.get('/api/v1/diary/2026-03-14')).json.goal.kcal, 2500);
  assert.equal((await w.ann.get('/api/v1/me')).json.goal.days_goal, undefined);
});

const exportJson = async (w: World, who: string) => {
  const res = await fetch(`http://127.0.0.1:${w.port}/api/v1/me/export`, { headers: { 'remote-user': who, 'x-mahlwerk-request': '1' } });
  const files = await unzip(new Uint8Array(await res.arrayBuffer()), ['mahlwerk-export.json']);
  return JSON.parse(new TextDecoder().decode(files['mahlwerk-export.json']));
};
const importJson = async (w: World, who: string, data: unknown, mode = 'merge') => {
  const call = async (path: string, body: string) => {
    const res = await fetch(`http://127.0.0.1:${w.port}${path}`, { method: 'POST', body, headers: { 'remote-user': who, 'x-mahlwerk-request': '1', 'content-type': path.endsWith('preview') ? 'application/octet-stream' : 'application/json' } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const p = await call('/api/v1/me/import/preview', JSON.stringify(data));
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const c = await call('/api/v1/me/import/confirm', JSON.stringify({ token: p.json.token, mode }));
  assert.equal(c.status, 200, JSON.stringify(c.json));
  return c.json;
};

test('the weekday goal travels through the data export and import, in the goal and in every history row', async () => {
  const one = await world(), two = await world();
  await one.ann.put('/api/v1/me/goal', GOAL); // creates the user
  const uid = (await one.ctx.db.get<any>("SELECT id FROM user WHERE username = 'ann'"))!.id;
  await setGoal(one.ctx.db, uid, base(1900), '2026-02-01', 1, { days: MASK_FRSASO, kcal: 2300, protein: 120, carbs: 280, fat: 80 });
  await one.ann.put('/api/v1/me/goal', { ...GOAL, days_goal: DAYS }); // today: the newest row
  // the newest row is the one of today (set above), an older one carries another schedule
  const data = await exportJson(one, 'ann');
  assert.deepEqual(data.goal.days_goal, DAYS);
  assert.deepEqual(data.goal_history.at(-1).days_goal, DAYS);
  assert.deepEqual(data.goal_history.find((h: any) => h.valid_from === '2026-02-01').days_goal.weekdays, [5, 6, 7]);
  await importJson(two, 'anna', data);
  const there = await exportJson(two, 'anna');
  assert.deepEqual(there.goal, data.goal);
  assert.deepEqual(there.goal_history, data.goal_history);
  assert.deepEqual(((await two.who('anna').get('/api/v1/me')).json.goal.days_goal), DAYS);
  assert.equal((await two.who('anna').get('/api/v1/diary/2026-02-06')).json.goal.kcal, 2300); // a Friday in the old schedule
  assert.equal((await two.who('anna').get('/api/v1/diary/2026-02-05')).json.goal.kcal, 1900);
  // the same file again changes nothing, and a replace gives the same
  const again = await importJson(two, 'anna', data);
  assert.equal(again.counts.goal.unchanged + again.counts.goal_history.unchanged, 1 + data.goal_history.length);
  await importJson(two, 'anna', data, 'replace');
  assert.deepEqual((await exportJson(two, 'anna')).goal_history, data.goal_history);
});

test('an export from before the weekday goal imports as a goal without one and a file with a broken one is refused', async () => {
  const one = await world(), two = await world();
  await one.ann.put('/api/v1/me/goal', GOAL);
  const data = await exportJson(one, 'ann');
  assert.ok(!('days_goal' in data.goal) || data.goal.days_goal == null);
  delete data.goal.days_goal;
  for (const h of data.goal_history) delete h.days_goal;
  await importJson(two, 'anna', data);
  const me = (await two.who('anna').get('/api/v1/me')).json.goal;
  assert.equal(me.kcal, 2000);
  assert.equal(me.days_goal, undefined);
  // a file whose own goal is set when the one here has none: file wins, also the other way round (a file without it removes it)
  await two.who('anna').put('/api/v1/me/goal', { ...GOAL, days_goal: DAYS });
  assert.deepEqual((await two.who('anna').get('/api/v1/me')).json.goal.days_goal, DAYS);
  await importJson(two, 'anna', data, 'replace');
  assert.equal((await two.who('anna').get('/api/v1/me')).json.goal.days_goal, undefined);
  // a broken schedule in the file is refused as a whole
  const broken = JSON.parse(JSON.stringify(data));
  broken.goal.days_goal = { ...DAYS, weekdays: [1, 2, 3, 4, 5, 6, 7] };
  const res = await fetch(`http://127.0.0.1:${two.port}/api/v1/me/import/preview`, { method: 'POST', body: JSON.stringify(broken), headers: { 'remote-user': 'anna', 'x-mahlwerk-request': '1', 'content-type': 'application/octet-stream' } });
  assert.equal(res.status, 422);
});
