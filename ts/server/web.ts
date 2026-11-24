// The built frontend (main.py `mount_web`): files of the web directory, and index.html for every unknown path so that client-side
// routes survive a reload. Node only (reads files).
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { buildCsp } from '../core/security.ts';
import type { Res } from '../core/http.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/vnd.microsoft.icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
};

/** Built files under assets/ carry a hash in their name and never change: cached for a year. Everything else (index.html above all)
 * is checked with the server each time, so a new version shows up at the next start instead of hours later. */
const cacheHeaders = (relFirst: string): Record<string, string> =>
  relFirst === 'assets' ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : { 'Cache-Control': 'no-cache' };

export interface Web {
  /** The file for a (decoded) request path without the leading slash, index.html for an unknown one, null without index.html. */
  serve(path: string): Res | null;
  csp: Promise<string>;
}

/** The web directory, or null when there is none (then nothing is mounted and the CSP has no inline-script hashes). */
export function openWeb(dir: string): Web | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const root = realpathSync(dir);
  const file = (path: string, first: string): Res => ({
    status: 200, headers: { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', ...cacheHeaders(first) }, body: new Uint8Array(readFileSync(path)),
  });
  return {
    csp: buildCsp(existsSync(join(root, 'index.html')) ? readFileSync(join(root, 'index.html'), 'utf8') : null),
    serve(path) {
      try {
        const target = realpathSync(join(root, path)); // follows symlinks: what counts is where the file really is
        if ((target === root || target.startsWith(root + sep)) && statSync(target).isFile()) return file(target, path.split('/')[0]!);
      } catch { /* not there: index.html */ }
      const index = join(root, 'index.html');
      return existsSync(index) && statSync(index).isFile() ? file(index, 'index.html') : null;
    },
  };
}
