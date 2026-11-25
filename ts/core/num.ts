// Numbers like Python: round() rounds half to even, with an optional number of digits.

/** Python's round(x, digits): rounds the exact binary value (round(2.675, 2) == 2.67, it is 2.67499…), only exact
 * ties go to the even neighbour (round(0.125, 2) == 0.12, round(2.5) == 2). */
export function roundHalfEven(x: number, digits = 0): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  // fast path: |x| * 10^digits is below 1e9, so the product is within 1.2e-7 of the exact one; when its fraction is farther than
  // 1e-6 from .5, rounding the product gives the same integer as rounding the exact value (near an integer both ways end on it).
  // Only values that are (almost) a tie take the exact way below. tests/num.test.ts compares both on millions of values.
  if (digits >= 0 && digits <= 15) {
    const p = Math.abs(x) * 10 ** digits;
    if (p < 1e9) {
      const floor = Math.floor(p);
      const f = p - floor;
      if (Math.abs(f - 0.5) > 1e-6) {
        const out = (f > 0.5 ? floor + 1 : floor) / 10 ** digits;
        return x < 0 ? -out || 0 : out;
      }
    }
  }
  return exactRound(x, digits);
}

/** The exact way: the decimal digits of the binary value. */
export function exactRound(x: number, digits: number): number {
  const s = Math.abs(x).toFixed(Math.min(100, digits + 40)); // enough exact decimals of the binary value
  const [int, frac] = s.split('.');
  const keep = int + frac.slice(0, digits);
  const rest = frac.slice(digits);
  const up = rest[0] > '5' || (rest[0] === '5' && (/[1-9]/.test(rest.slice(1)) || Number(keep.at(-1)) % 2 === 1));
  const n = BigInt(keep) + (up ? 1n : 0n);
  const out = Number(n) / 10 ** digits;
  return x < 0 ? -out || 0 : out;
}

/** Python's sum() of floats (3.12+ adds with Neumaier compensation, so sums of decimals differ from a plain loop). */
export function pySum(values: Iterable<number>): number {
  let sum = 0;
  let c = 0;
  for (const x of values) {
    const t = sum + x;
    c += Math.abs(sum) >= Math.abs(x) ? (sum - t) + x : (x - t) + sum;
    sum = t;
  }
  return c !== 0 && Number.isFinite(c) ? sum + c : sum;
}
