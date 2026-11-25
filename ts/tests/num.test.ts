// roundHalfEven (core/num.ts): the fast path must give exactly what the exact way (decimal digits of the binary value) gives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exactRound, roundHalfEven } from '../core/num.ts';

let seed = 20261125;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const buf = new Float64Array(1);
const next = (x: number, up: boolean) => { buf[0] = x; const u = new BigInt64Array(buf.buffer); u[0] += (x >= 0) === up ? 1n : -1n; return buf[0]!; };

test('Python examples', () => {
  assert.equal(roundHalfEven(2.675, 2), 2.67);
  assert.equal(roundHalfEven(0.125, 2), 0.12);
  assert.equal(roundHalfEven(0.375, 2), 0.38);
  assert.equal(roundHalfEven(2.5), 2);
  assert.equal(roundHalfEven(3.5), 4);
  assert.equal(roundHalfEven(-0.5), 0);
  assert.ok(Object.is(roundHalfEven(-0.4), 0));
  assert.equal(roundHalfEven(1e22, 2), 1e22);
});

test('fast path equals the exact way on random values, ties and their neighbours (1.5 million cases)', () => {
  let n = 0, bad = 0, first = '';
  const check = (x: number, d: number) => {
    n++;
    const a = roundHalfEven(x, d), b = exactRound(x, d);
    if (!Object.is(a, b) && !(Number.isFinite(x) && Math.abs(x) >= 1e21)) { bad++; first ||= `${x} ${d}: ${a} vs ${b}`; }
  };
  for (let i = 0; i < 250_000; i++) {
    const d = i % 7; // 0..6, what the callers use
    const scale = 10 ** d;
    const mag = [1, 10, 100, 1000, 1e5, 1e-3, 1e8, 3e9][i % 8]!;
    const x = (rnd() - 0.3) * mag;
    check(x, d);
    const k = Math.floor(rnd() * 1e6) - 2e5;
    const tie = (k + 0.5) / scale; // a decimal tie (rarely exact in binary)
    check(tie, d); check(next(tie, true), d); check(next(tie, false), d);
    const whole = k / scale; // on a rounding result
    check(next(whole, true), d); check(next(whole, false), d);
  }
  assert.equal(bad, 0, first);
  assert.ok(n >= 1_500_000);
});
