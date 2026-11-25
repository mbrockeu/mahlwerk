// Recipe pictures: from the bytes somebody sent (or a provider served) to three small, clean WebP files (imageproc.py, parent side).
//
// The input is hostile until proven otherwise, so the decoding is done by the host in a child process with limits it enforces
// (server/imageRunner.ts; the child is server/imageChild.ts): only JPEG, PNG and WebP, at most MAX_PIXELS (24 megapixels), only the
// first frame, the camera's rotation applied, EVERY piece of metadata dropped (no EXIF/GPS, no profile, no thumbnail), transparency
// laid on the paper colour, three fixed sizes (`l` long edge 960 px, `m` 240 px square, `s` 96 px square). Here: what the parent
// checks before it starts a child, and what it checks again on what the child sends back. The file name is derived from the content.
import { dimensions } from './imagesize.ts';

export const MAX_PIXELS = 24_000_000;
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const SIZES = { l: 960, m: 240, s: 96 } as const; // long edge of the detail picture; edge of the square crops
export type SizeKey = keyof typeof SIZES;
export const MODEL_EDGE = 1568; // long edge of the picture sent to an image model
export const MAX_MODEL_BYTES = 4 * 1024 * 1024;
const MAGIC = 'MWI1';
const MAX_OUTPUT_BYTES: Record<SizeKey, number> = { l: 1024 * 1024, m: 200 * 1024, s: 64 * 1024 }; // far above what the encoder produces

export type ImageKind = 'format' | 'too_large' | 'too_many_pixels' | 'broken' | 'busy' | 'unavailable';

const TEXTS: Record<string, string> = {
  format: 'the picture must be a JPEG, PNG or WebP file',
  too_large: 'the picture file is too large',
  too_many_pixels: `the picture has too many pixels (at most ${Math.floor(MAX_PIXELS / 1_000_000)} megapixels)`,
  broken: 'the picture could not be read',
  busy: 'another picture is being processed, try again in a moment',
  unavailable: 'pictures cannot be processed on this server (the image library is missing)',
};

/** The picture cannot be used. The text is for the person. */
export class ImageRejected extends Error {
  kind: ImageKind;
  constructor(kind: ImageKind) {
    super(TEXTS[kind] ?? kind);
    this.kind = kind;
  }
}

export interface Processed { hash: string; width: number; height: number; files: Record<SizeKey, Uint8Array> }

/** What runs the child (the host): `recipe` gives the three WebP files in one blob, `model` one JPEG. */
export interface ImageRunner { run(data: Uint8Array, mode: 'recipe' | 'model'): Promise<Uint8Array> }

export const STATUS_OF: Record<string, number> = { too_large: 413, too_many_pixels: 413, busy: 503, unavailable: 501, format: 422, broken: 422 };

/** Checks of the parent before any child exists (the size from the header, never from a decode). */
export function precheck(data: Uint8Array): void {
  if (data.length > MAX_INPUT_BYTES) throw new ImageRejected('too_large');
  const size = dimensions(data);
  if (size === null || size[0] < 1 || size[1] < 1) throw new ImageRejected('format');
  if (size[0] * size[1] > MAX_PIXELS) throw new ImageRejected('too_many_pixels');
}

const same = (a: [number, number] | null, b: [number, number]): boolean => a !== null && a[0] === b[0] && a[1] === b[1];

async function sha256Hex(parts: Uint8Array[]): Promise<string> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The three variants of the picture in `data`, else ImageRejected. */
export async function processImage(runner: ImageRunner, data: Uint8Array): Promise<Processed> {
  precheck(data);
  return parseProcessed(await runner.run(data, 'recipe'));
}

/** The picture as ONE clean JPEG for an image model: long edge at most MODEL_EDGE, no metadata at all, the camera's rotation applied. */
export async function forModel(runner: ImageRunner, data: Uint8Array): Promise<Uint8Array> {
  precheck(data);
  const blob = await runner.run(data, 'model');
  if (blob[0] !== 0xff || blob[1] !== 0xd8) throw new ImageRejected('broken');
  const size = dimensions(blob);
  if (size === null || !(Math.max(...size) >= 1 && Math.max(...size) <= MODEL_EDGE) || blob.length > MAX_MODEL_BYTES) throw new ImageRejected('broken');
  return blob;
}

/** The child's answer is checked again with the header parser: the sizes it claims are the sizes the files have, and they are the ones we make. */
export async function parseProcessed(blob: Uint8Array): Promise<Processed> {
  try {
    if (new TextDecoder().decode(blob.subarray(0, 4)) !== MAGIC) throw new Error('magic');
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const headLen = view.getUint32(4, false);
    const head = JSON.parse(new TextDecoder().decode(blob.subarray(8, 8 + headLen)));
    let offset = 8 + headLen;
    const width = Number(head.width);
    const height = Number(head.height);
    const files = {} as Record<SizeKey, Uint8Array>;
    for (const key of Object.keys(SIZES) as SizeKey[]) {
      const length = Number(head.lengths[key]);
      const file = blob.subarray(offset, offset + length);
      const tag = (from: number, to: number) => new TextDecoder().decode(file.subarray(from, to));
      if (!Number.isInteger(length) || file.length !== length || length < 12 || tag(0, 4) !== 'RIFF' || tag(8, 12) !== 'WEBP') throw new Error('file');
      offset += length;
      const want: [number, number] = key === 'l' ? [width, height] : [SIZES[key], SIZES[key]];
      if (!same(dimensions(file), want) || length > MAX_OUTPUT_BYTES[key]) throw new Error('size');
      files[key] = file;
    }
    if (offset !== blob.length || !(width >= 1 && width <= SIZES.l && height >= 1 && height <= SIZES.l)) throw new Error('shape');
    const hash = (await sha256Hex([files.l, files.m, files.s])).slice(0, 32); // over all three files: they belong together
    return { hash, width, height, files };
  } catch {
    throw new ImageRejected('broken');
  }
}
