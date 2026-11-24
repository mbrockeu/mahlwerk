// The picture child (imageproc.py `_main`): runs in a process of its own with limits the parent sets (server/imageRunner.ts).
// stdin: the picture; stdout: the result; on refusal: exit code 2 and the kind on stderr. Never run by anything but the parent.
import sharp, { type Sharp } from 'sharp';
import { dimensions } from '../core/imagesize.ts';
import { MAX_INPUT_BYTES, MAX_PIXELS, MODEL_EDGE, SIZES, type SizeKey } from '../core/imageproc.ts';

const MAX_DECODED_BYTES = 300 * 1024 * 1024; // what the decoded pixels of the first frame may need
const DETAIL_TARGET_BYTES = 150 * 1024; // the detail picture is encoded again with lower quality until it is below this
const PAPER = { r: 0xf7, g: 0xf8, b: 0xf5 }; // the paper colour of the app: transparency is laid on it
const MODEL_QUALITY = 85;
const MAGIC = 'MWI1';
const DEPTH_BYTES: Record<string, number> = { uchar: 1, char: 1, ushort: 2, short: 2, uint: 4, int: 4, float: 4, complex: 8, double: 8, dpcomplex: 16 };

class Rejected extends Error {
  kind: string;
  constructor(kind: string) { super(kind); this.kind = kind; }
}

// only the three formats this server accepts may be decoded at all: every other loader of the library is switched off
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'] });
sharp.cache(false);
sharp.concurrency(1);

const open = (data: Buffer) => sharp(data, { failOn: 'error', limitInputPixels: MAX_PIXELS, sequentialRead: true, ignoreIcc: true });

/** The picture as upright, flat sRGB pixels: only the first frame, the camera's rotation applied, transparency on the paper colour. */
async function upright(data: Buffer): Promise<Sharp> {
  let meta;
  try {
    meta = await open(data).metadata();
  } catch {
    throw new Rejected('format');
  }
  if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '')) throw new Rejected('format');
  const { width = 0, height = 0 } = meta;
  if (width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Rejected('too_many_pixels');
  if (meta.format !== 'jpeg' && width * height * (meta.channels ?? 3) * (DEPTH_BYTES[meta.depth ?? 'uchar'] ?? 1) > MAX_DECODED_BYTES) throw new Rejected('too_many_pixels');
  return open(data).rotate().flatten({ background: PAPER }).toColourspace('srgb').removeAlpha();
}

const encode = (img: Sharp, quality: number) => img.webp({ quality, effort: 4 }).toBuffer();

async function variants(data: Buffer) {
  const base = await upright(data);
  const files = {} as Record<SizeKey, Buffer>;
  const detail = base.clone().resize(SIZES.l, SIZES.l, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' });
  for (const quality of [82, 74, 66, 58, 50]) {
    files.l = await encode(detail.clone(), quality);
    if (files.l.length <= DETAIL_TARGET_BYTES) break;
  }
  for (const key of ['m', 's'] as const) {
    files[key] = await encode(base.clone().resize(SIZES[key], SIZES[key], { fit: 'cover', position: 'centre', kernel: 'lanczos3' }), 78);
  }
  const size = dimensions(files.l)!;
  return { files, width: size[0], height: size[1] };
}

async function main(mode: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of process.stdin) {
    total += (c as Buffer).length;
    if (total > MAX_INPUT_BYTES) throw new Rejected('too_large');
    chunks.push(c as Buffer);
  }
  const data = Buffer.concat(chunks);
  const size = dimensions(data);
  if (size === null) throw new Rejected('format');
  if (size[0] * size[1] > MAX_PIXELS) throw new Rejected('too_many_pixels');
  if (mode === 'model') {
    const img = await upright(data);
    // a new image from the pixels alone: sharp writes no metadata unless asked to
    return img.resize(MODEL_EDGE, MODEL_EDGE, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
      .jpeg({ quality: MODEL_QUALITY, optimiseCoding: true }).toBuffer();
  }
  const { files, width, height } = await variants(data);
  const head = Buffer.from(JSON.stringify({ width, height, lengths: { l: files.l.length, m: files.m.length, s: files.s.length } }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  return Buffer.concat([Buffer.from(MAGIC), len, head, files.l, files.m, files.s]);
}

if (process.env.MAHLWERK_IMAGE_CHILD !== '1') {
  process.stderr.write('broken\n');
  process.exit(2);
}
try {
  process.stdout.write(await main(process.argv[2] ?? ''), () => process.exit(0));
} catch (e) {
  process.stderr.write((e instanceof Rejected ? e.kind : 'broken') + '\n', () => process.exit(2));
}
