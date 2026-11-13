import test from 'node:test';
import assert from 'node:assert/strict';
import * as w from '../src/lib/workouts.ts';

test('the kinds are the 19 of the server with positive MET values', () => {
  assert.equal(w.KINDS.length, 19);
  assert.equal(new Set(w.KINDS.map((k) => k.key)).size, 19);
  assert.ok(w.KINDS.every((k) => k.met > 0 && k.icon));
  assert.equal(w.KINDS[w.KINDS.length - 1].key, 'other');
  assert.equal(w.kindInfo('nonsense').key, 'other');
});

test('the estimate is MET x weight x hours', () => {
  assert.equal(w.estimateKcal('running', 30, 80), 392);
  assert.equal(w.estimateKcal('walking', 60, 80), 280);
  assert.equal(w.estimateKcal('cycling', 60, null), Math.round(7.5 * 75));
  assert.equal(w.estimateKcal('yoga', 0, 80), 0);
});

test('start times are read as local clock time', () => {
  const at = w.startAt('2026-11-12', '07:05');
  assert.equal(w.clock(at), '07:05');
  assert.equal(w.startAt('2026-11-12', '24:00'), null);
  assert.equal(w.startAt('2026-11-12', 'soon'), null);
  assert.equal(w.startAt('2026-11-12', ''), null);
});

test('step share is capped and safe', () => {
  assert.equal(w.stepShare(4000, 8000), 0.5);
  assert.equal(w.stepShare(20000, 8000), 1);
  assert.equal(w.stepShare(null, 8000), 0);
  assert.equal(w.stepShare(100, 0), 0);
});
