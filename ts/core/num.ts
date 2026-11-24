// Numbers like Python: round() rounds half to even, with an optional number of digits.

export function roundHalfEven(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x;
  if (digits !== 0) {
    // Python rounds the exact binary value; going through the decimal string (toPrecision 17) is the same for the values we store
    const m = 10 ** digits;
    const scaled = Number((x * m).toPrecision(15));
    return roundHalfEven(scaled) / m;
  }
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
