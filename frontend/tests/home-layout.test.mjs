import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOME, HOME_IDS, defaultHome, move, normalize, sameHome, toggleHidden, toggleWide } from '../src/lib/homeLayout.ts';

const ids = (l) => l.map((c) => c.id);

test('the default has every card once, the old widths and nothing hidden', () => {
  assert.deepEqual(ids(DEFAULT_HOME), [...HOME_IDS]);
  assert.ok(DEFAULT_HOME.every((c) => !c.hidden));
  const wide = Object.fromEntries(DEFAULT_HOME.map((c) => [c.id, c.wide]));
  assert.deepEqual(wide, { ring: false, macros: false, fasting: true, water: false, activity: false, weight: true, meals: true, micros: true, suggestions: false });
});

test('null and rubbish give the default', () => {
  assert.deepEqual(normalize(null), defaultHome());
  assert.deepEqual(normalize('x'), defaultHome());
  assert.deepEqual(normalize(undefined), defaultHome());
});

test('unknown and doubled ids are dropped, missing ones are appended with their defaults', () => {
  const out = normalize([
    { id: 'weight', hidden: true, wide: false }, { id: 'nope' }, { id: 'weight', hidden: false, wide: true }, null, { id: 'ring' },
  ]);
  assert.deepEqual(ids(out), ['weight', 'ring', 'macros', 'fasting', 'water', 'activity', 'meals', 'micros', 'suggestions']);
  assert.deepEqual(out[0], { id: 'weight', hidden: true, wide: false }); // the first one wins
  assert.deepEqual(out[1], { id: 'ring', hidden: false, wide: false }); // a missing wide falls back to the default
  assert.deepEqual(out.at(-1), { id: 'suggestions', hidden: false, wide: false });
});

test('move shifts one card and never changes the input', () => {
  const list = defaultHome();
  const out = move(list, 0, 2);
  assert.deepEqual(ids(out).slice(0, 3), ['macros', 'fasting', 'ring']);
  assert.deepEqual(ids(list), [...HOME_IDS]);
  assert.deepEqual(ids(move(list, 3, 0)).slice(0, 2), ['water', 'ring']);
  assert.deepEqual(ids(move(list, 1, 1)), [...HOME_IDS]);
  assert.deepEqual(ids(move(list, -1, 2)), [...HOME_IDS]);
  assert.deepEqual(ids(move(list, 2, 99)), [...HOME_IDS]);
});

test('toggles change only the named card', () => {
  const list = defaultHome();
  const h = toggleHidden(list, 'water');
  assert.equal(h.find((c) => c.id === 'water').hidden, true);
  assert.equal(h.filter((c) => c.hidden).length, 1);
  assert.equal(list.find((c) => c.id === 'water').hidden, false);
  const w = toggleWide(toggleWide(list, 'ring'), 'ring');
  assert.ok(sameHome(w, list));
  assert.equal(toggleWide(list, 'ring')[0].wide, true);
});

test('sameHome compares order, hidden and width', () => {
  assert.ok(sameHome(defaultHome(), DEFAULT_HOME));
  assert.ok(!sameHome(defaultHome(), move(defaultHome(), 0, 1)));
  assert.ok(!sameHome(defaultHome(), toggleHidden(defaultHome(), 'ring')));
});
