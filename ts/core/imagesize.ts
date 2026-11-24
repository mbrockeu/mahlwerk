// Pixel size of a JPEG, PNG or WebP read from the file header, without decoding the picture (imagesize.py).
export const MAX_PIXELS = 25_000_000;

const startsWith = (d: Uint8Array, bytes: number[], at = 0): boolean => bytes.every((b, i) => d[at + i] === b);
const ascii = (d: Uint8Array, from: number, to: number): string => String.fromCharCode(...d.subarray(from, to));
const u16be = (d: Uint8Array, i: number): number => { if (i + 2 > d.length) throw new RangeError('short'); return (d[i]! << 8) | d[i + 1]!; };
const u32be = (d: Uint8Array, i: number): number => { if (i + 4 > d.length) throw new RangeError('short'); return ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0; };
const u16le = (d: Uint8Array, i: number): number => { if (i + 2 > d.length) throw new RangeError('short'); return d[i]! | (d[i + 1]! << 8); };
const u32le = (d: Uint8Array, i: number): number => { if (i + 4 > d.length) throw new RangeError('short'); return (d[i]! | (d[i + 1]! << 8) | (d[i + 2]! << 16) | (d[i + 3]! << 24)) >>> 0; };
const u24le = (d: Uint8Array, i: number): number => { if (i + 3 > d.length) throw new RangeError('short'); return d[i]! | (d[i + 1]! << 8) | (d[i + 2]! << 16); };

export function dimensions(data: Uint8Array): [number, number] | null {
  try {
    if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && ascii(data, 12, 16) === 'IHDR') return [u32be(data, 16), u32be(data, 20)];
    if (startsWith(data, [0xff, 0xd8])) return jpeg(data);
    if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return webp(data);
  } catch {
    return null;
  }
  return null;
}

function jpeg(data: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff) { i += 1; continue; }
    const marker = data[i + 1]!;
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // markers without a length
    const length = u16be(data, i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { // a start-of-frame marker
      return [u16be(data, i + 7), u16be(data, i + 5)];
    }
    i += 2 + length;
  }
  return null;
}

function webp(data: Uint8Array): [number, number] | null {
  const kind = ascii(data, 12, 16);
  if (kind === 'VP8 ') return [u16le(data, 26) & 0x3fff, u16le(data, 28) & 0x3fff];
  if (kind === 'VP8L') {
    const bits = u32le(data, 21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (kind === 'VP8X') return [u24le(data, 24) + 1, u24le(data, 27) + 1];
  return null;
}
