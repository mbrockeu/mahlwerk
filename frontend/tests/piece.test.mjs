// The pure helpers of pieces ("2 × slice"): lib/piece.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPiece, gramsToPieces, isHalfMultiple, piecesText, piecesToGrams, splitGrams } from '../src/lib/piece.ts';

test('pieces become grams and back', () => {
  assert.equal(piecesToGrams(2, 25), 50);
  assert.equal(piecesToGrams(1.5, 25), 37.5);
  assert.equal(piecesToGrams(3, 33.333), 99.999);
  assert.equal(gramsToPieces(50, 25), 2);
  assert.equal(gramsToPieces(60, 25), 2.4);
});

test('a whole or half number of pieces is recognised', () => {
  assert.equal(isHalfMultiple(50, 25), true);
  assert.equal(isHalfMultiple(37.5, 25), true);
  assert.equal(isHalfMultiple(12.5, 25), true);
  assert.equal(isHalfMultiple(60, 25), false);
  assert.equal(isHalfMultiple(10, 25), false);  // less than half a piece
  assert.equal(isHalfMultiple(99.999, 33.333), true);  // rounded amounts still count
  assert.equal(isHalfMultiple(0, 25), false);
  assert.equal(isHalfMultiple(50, 0), false);
});

test('the text of a count has the same pattern in every language', () => {
  assert.equal(piecesText(2, 'Scheibe'), '2 × Scheibe');
  assert.equal(piecesText(1.5, 'Slice', (n) => String(n).replace('.', ',')), '1,5 × Slice');
});

test('a piece is accepted only as the server would accept it', () => {
  assert.deepEqual(checkPiece('  Scheibe ', 25), { label: 'Scheibe', grams: 25 });
  assert.equal(checkPiece('', 25), null);
  assert.equal(checkPiece('   ', 25), null);
  assert.equal(checkPiece('x'.repeat(31), 25), null);
  assert.deepEqual(checkPiece('x'.repeat(30), 5000), { label: 'x'.repeat(30), grams: 5000 });
  assert.equal(checkPiece('Scheibe', 0), null);
  assert.equal(checkPiece('Scheibe', 5001), null);
  assert.equal(checkPiece('Scheibe', null), null);
  assert.equal(checkPiece('Scheibe', NaN), null);
});

test('a share of a whole: total divided into parts, some eaten', () => {
  assert.equal(splitGrams(1250, 8, 2), 312.5);
  assert.equal(splitGrams(1000, 3, 1), 333.333);
  assert.equal(splitGrams(1250, 8, 0.5), 78.125);  // half a slice
  assert.equal(splitGrams(1250, 8, 9), null);  // more than there was
  assert.equal(splitGrams(0, 8, 2), null);
  assert.equal(splitGrams(1250, 0, 2), null);
  assert.equal(splitGrams(null, 8, 2), null);
  assert.equal(splitGrams(20000, 2, 1), null);  // above 5000 g
});
