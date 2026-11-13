import test from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/lib/account.ts';

test('password length is counted in characters, 10 to 256', () => {
  assert.equal(a.passwordProblem('123456789'), 'short');
  assert.equal(a.passwordProblem('1234567890'), null);
  assert.equal(a.passwordProblem('x'.repeat(256)), null);
  assert.equal(a.passwordProblem('x'.repeat(257)), 'long');
  assert.equal(a.passwordProblem('😀'.repeat(10)), null);
});
test('user names follow the server rule after trimming and lower-casing', () => {
  assert.ok(a.nameValid(' Alex '));
  assert.ok(a.nameValid('sam.k-2_x'));
  assert.ok(!a.nameValid(''));
  assert.ok(!a.nameValid('-sam'));
  assert.ok(!a.nameValid('a b'));
  assert.ok(!a.nameValid('x'.repeat(41)));
  assert.equal(a.normalizeName(' Alex '), 'alex');
});
test('waiting time text', () => {
  assert.equal(a.waitText(2), '2 s');
  assert.equal(a.waitText(0), '1 s');
  assert.equal(a.waitText(300), '5 min');
  assert.equal(a.waitText(900), '15 min');
});

test('display name: blanks collapse, 1 to 60 characters, no control characters', () => {
  assert.equal(a.cleanDisplayName('  Jürgen   der  Große '), 'Jürgen der Große');
  assert.equal(a.nameProblem('   '), 'empty');
  assert.equal(a.nameProblem('a'.repeat(60)), null);
  assert.equal(a.nameProblem('a'.repeat(61)), 'long');
  assert.equal(a.nameProblem('😀'.repeat(60)), null);
  assert.equal(a.nameProblem('a\nb'), 'bad');
});
test('the avatar initial is a whole character, upper-cased', () => {
  assert.equal(a.initialOf('ärger'), 'Ä');
  assert.equal(a.initialOf('🍳 Chef'), '🍳');
  assert.equal(a.initialOf('', 'x'), 'X');
  assert.equal(a.initialOf(null), '');
});
