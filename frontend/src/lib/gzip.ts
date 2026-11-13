/** Packs a file with gzip before it is sent (where the browser can), because a proxy in front of the server often limits the
 *  size of a request body to a few megabytes. The server accepts packed and plain files alike and unpacks with a hard limit.
 *  Returns the file itself when the browser has no CompressionStream. */
export async function packFile(file: Blob): Promise<Blob> {
  if (typeof CompressionStream === 'undefined' || typeof file.stream !== 'function') return file;
  try {
    const packed = await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    return new Blob([packed], { type: 'application/octet-stream' });
  } catch {
    return file;
  }
}

/** The name the server expects for a chosen file (`days.json`, `products.json`, `weight.json`, `export.zip`), or null. */
export function exportName(fileName: string): string | null {
  const base = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base === 'days.json' || base === 'products.json' || base === 'weight.json') return base;
  return base.endsWith('.zip') ? 'export.zip' : null;
}
