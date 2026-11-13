// Phone photos are huge; shrink them in the browser until they fit a typical reverse-proxy
// upload limit (nginx defaults to 1 MB).
const MAX_UPLOAD_BYTES = 900 * 1024;

/** The ladder of (longest edge, JPEG quality) tried in turn; `maxSide` cuts off the steps above it and starts at that edge. */
export function shrinkSteps(maxSide = 2000): [number, number][] {
  const all: [number, number][] = [[2000, 0.85], [1800, 0.75], [1600, 0.7], [1400, 0.6], [1200, 0.5]];
  if (maxSide >= 2000) return all;
  const lower = all.filter(([side]) => side < maxSide);
  return [[maxSide, 0.8], ...lower];
}

/** `maxSide` / `maxBytes`: for a photo that goes to the image model (1600 px, well under its 8 MB limit); the defaults are for recipe pictures. */
export async function shrink(file: Blob, opts: { maxSide?: number; maxBytes?: number } = {}): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let blob: Blob | null = null;
  const limit = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  for (const [maxSide, quality] of shrinkSteps(opts.maxSide)) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= limit) break;
  }
  bitmap.close();
  if (!blob) throw new Error('encode');
  return blob;
}
