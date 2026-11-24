// Numbers like Python: round() rounds half to even, with an optional number of digits.

/** Python's round(x, digits): rounds the exact binary value (round(2.675, 2) == 2.67, it is 2.67499…), only exact
 * ties go to the even neighbour (round(0.125, 2) == 0.12, round(2.5) == 2). */
export function roundHalfEven(x: number, digits = 0): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const s = Math.abs(x).toFixed(Math.min(100, digits + 40)); // enough exact decimals of the binary value
  const [int, frac] = s.split('.');
  const keep = int + frac.slice(0, digits);
  const rest = frac.slice(digits);
  const up = rest[0] > '5' || (rest[0] === '5' && (/[1-9]/.test(rest.slice(1)) || Number(keep.at(-1)) % 2 === 1));
  const n = BigInt(keep) + (up ? 1n : 0n);
  const out = Number(n) / 10 ** digits;
  return x < 0 ? -out || 0 : out;
}
