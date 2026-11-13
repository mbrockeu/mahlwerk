import test from 'node:test';
import assert from 'node:assert/strict';
import { swipeDecision, dragOffset } from '../src/lib/sheetSwipe.ts';

test('a long pull closes', () => {
  assert.equal(swipeDecision(130, 900, 800), 'close');
});
test('a quarter of a short sheet closes', () => {
  assert.equal(swipeDecision(90, 900, 340), 'close');
});
test('a short slow pull springs back', () => {
  assert.equal(swipeDecision(60, 800, 800), 'back');
});
test('a quick flick closes after a short pull', () => {
  assert.equal(swipeDecision(50, 60, 800), 'close');
});
test('a flick that is too short does not close', () => {
  assert.equal(swipeDecision(20, 10, 800), 'back');
});
test('upwards or no move never closes', () => {
  assert.equal(swipeDecision(-200, 50, 800), 'back');
  assert.equal(swipeDecision(0, 0, 800), 'back');
});
test('the sheet only follows downwards', () => {
  assert.equal(dragOffset(-30), 0);
  assert.equal(dragOffset(42), 42);
});
