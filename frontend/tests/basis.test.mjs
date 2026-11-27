import test from 'node:test';
import assert from 'node:assert/strict';
import { per100Of, servingAmount, servingText } from '../src/lib/basis.ts';

test('the serving amount is the leading number in the product unit', () => {
  assert.equal(servingAmount('350 g', 'g'), 350);
  assert.equal(servingAmount(' 1,5g Pulver', 'g'), 1.5);
  assert.equal(servingAmount('250 ML', 'ml'), 250);
  assert.equal(servingAmount('250 ml', 'g'), null); // the other unit cannot be converted
  assert.equal(servingAmount('1 Stück', 'g'), null);
  assert.equal(servingAmount('0 g', 'g'), null);
  assert.equal(servingAmount('', 'g'), null);
  assert.equal(servingAmount('466', 'g'), 466); // a bare number is meant in the product unit
  assert.equal(servingAmount(' 0,5 ', 'ml'), 0.5);
});

test('a bare serving number is saved with the unit, anything else as typed', () => {
  assert.equal(servingText(' 466 ', 'g'), '466 g');
  assert.equal(servingText('2 Scheiben (50 g)', 'g'), '2 Scheiben (50 g)');
  assert.equal(servingText('', 'g'), '');
});

test('values per serving become values per 100, empty ones stay empty', () => {
  assert.equal(per100Of(500, 350), 142.86);
  assert.equal(per100Of(12, 30), 40);
  assert.equal(per100Of(0, 350), 0);
  assert.equal(per100Of(null, 350), null);
});
