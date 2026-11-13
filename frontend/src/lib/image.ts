// Phone photos are huge; shrink them in the browser until they fit a typical reverse-proxy
// upload limit (nginx defaults to 1 MB).
const MAX_UPLOAD_BYTES = 900 * 1024;

export async function shrink(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let blob: Blob | null = null;
  for (const [maxSide, quality] of [[2000, 0.85], [1800, 0.75], [1600, 0.7], [1400, 0.6], [1200, 0.5]]) {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= MAX_UPLOAD_BYTES) break;
  }
  bitmap.close();
  if (!blob) throw new Error('encode');
  return blob;
}
