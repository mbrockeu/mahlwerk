import test from 'node:test';
import assert from 'node:assert/strict';
import { pullIntent, pullOffset, pullReady, PULL_MAX, PULL_THRESHOLD } from '../src/lib/pull.ts';

test('a tiny move is not judged yet', () => {
  assert.equal(pullIntent(3, 6), 'wait');
  assert.equal(pullIntent(0, 0), 'wait');
});
test('a mostly vertical move down is a pull', () => {
  assert.equal(pullIntent(4, 30), 'pull');
  assert.equal(pullIntent(-10, 40), 'pull');
});
test('sideways or diagonal moves are not (day swipe keeps working)', () => {
  assert.equal(pullIntent(60, 12), 'ignore');
  assert.equal(pullIntent(-40, 30), 'ignore');
});
test('upwards is never a pull', () => {
  assert.equal(pullIntent(2, -40), 'ignore');
});
test('the offset is damped, monotonic and capped', () => {
  assert.equal(pullOffset(-5), 0);
  assert.equal(pullOffset(0), 0);
  assert.ok(pullOffset(50) < 50);
  assert.ok(pullOffset(100) > pullOffset(50));
  assert.ok(pullOffset(2000) <= PULL_MAX);
});
test('the threshold is reachable with a normal pull but not with a tiny one', () => {
  assert.equal(pullReady(pullOffset(20)), false);
  assert.equal(pullReady(pullOffset(200)), true);
  assert.equal(pullReady(PULL_THRESHOLD), true);
  assert.equal(pullReady(PULL_THRESHOLD - 1), false);
});
