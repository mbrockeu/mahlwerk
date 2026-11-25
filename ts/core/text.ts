// Python's str methods that JavaScript does different: whitespace, strip(), split(), splitlines(), casefold(), len().

// str.isspace() characters: JS \s lacks \x1c-\x1f and \x85 and has the BOM.
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const SPACE = new RegExp(`[${PY_SPACE}]`); // one character (all of them are in the BMP, so a code unit is a character)
const SPLIT = new RegExp(`[${PY_SPACE}]+`);
const LINES = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');

/** str.strip(). Scans from both ends: a pattern like `[ ]+$` would be tried at every blank of a long inner run (quadratic). */
export function pyStrip(s: string): string {
  let i = 0;
  let j = s.length;
  while (i < j && SPACE.test(s[i]!)) i++;
  while (j > i && SPACE.test(s[j - 1]!)) j--;
  return i === 0 && j === s.length ? s : s.slice(i, j);
}

/** str.split() without arguments: words between whitespace, no empty ones. */
export const pySplit = (s: string): string[] => pyStrip(s).split(SPLIT).filter((w) => w !== '');

/** str.splitlines(): no trailing empty line. */
export function pySplitLines(s: string): string[] {
  const parts = s.split(LINES);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** len(): code points. */
export const pyLen = (s: string): number => { let n = 0; for (const _ of s) n++; return n; };

/** s[:n] for code points. */
export const pyHead = (s: string, n: number): string => (s.length <= n ? s : [...s].slice(0, n).join(''));

/** str.strip(chars). */
export function stripChars(s: string, chars: string): string {
  const set = new Set([...chars]);
  const a = [...s];
  let i = 0;
  let j = a.length;
  while (i < j && set.has(a[i])) i++;
  while (j > i && set.has(a[j - 1])) j--;
  return a.slice(i, j).join('');
}

/** str.casefold() for the characters that matter here (ß, ſ, final sigma); the rest is lower-casing. */
export const casefold = (s: string): string => s.toLowerCase().replace(/ß/g, 'ss').replace(/ſ/g, 's').replace(/ς/g, 'σ');
