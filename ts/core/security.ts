// Response headers for every answer, the CSRF header, the host check and the request size limits (security.py). The parts that
// need no file system; the middleware order lives in server/app.ts, the web directory in server/web.ts.
import { sha256, utf8 } from './crypto.ts';

export const CSRF_HEADER = 'x-mahlwerk-request';
export const CSRF_VALUE = '1';
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

// Request body limits (bytes): everything is small JSON except the label photo, the photo of a recipe and the bulk Health upload. A
// realistic sync (400 days with up to 50 workouts a day of about 300 bytes each) stays below 6 MB, so 8 MB is the ceiling there.
const LIMIT_DEFAULT = 1 * 1024 * 1024;
const LIMIT_UPLOAD = 8 * 1024 * 1024;
const LIMITS: Record<string, number> = {
  '/api/v1/label-scans': LIMIT_UPLOAD, '/api/v1/health/sync': LIMIT_UPLOAD, '/api/v1/vision/meal': LIMIT_UPLOAD, '/api/v1/vision/recipe': LIMIT_UPLOAD,
};
// The Yazio export (days.json of a few years of entries) is big; this route has its own, larger limit (as sent: the browser packs
// large files with gzip first). Its decompressed size is limited again in yazio_stage.
const LIMIT_YAZIO = 24 * 1024 * 1024;
const LIMIT_PREFIXES: [string, number][] = [['/api/v1/me/yazio/files/', LIMIT_YAZIO]];
const PICTURE_PATH = /^\/api\/v1\/foods\/\d{1,12}\/image$/; // an own photo for a recipe (the interface shrinks it first)

export function limitFor(path: string): number {
  if (Object.hasOwn(LIMITS, path) || PICTURE_PATH.test(path)) return LIMITS[path] ?? LIMIT_UPLOAD;
  return LIMIT_PREFIXES.find(([prefix]) => path.startsWith(prefix))?.[1] ?? LIMIT_DEFAULT;
}

/** The Content-Security-Policy of the built interface: scripts are our own files, `'wasm-unsafe-eval'` for the barcode reader, and the
 * SHA-256 of each inline script in index.html (the theme script that runs before the first paint); styles allow `'unsafe-inline'`
 * (Svelte sets style attributes); images self, `data:` and `blob:`; no frames, no plugins, no base-tag tricks, forms only to
 * ourselves; nothing is loaded from other hosts. `indexHtml` is the text of the served index.html, or null without one. */
export async function buildCsp(indexHtml: string | null): Promise<string> {
  const hashes: string[] = [];
  if (indexHtml !== null) {
    for (const m of indexHtml.matchAll(INLINE_SCRIPT)) {
      const body = m[1]!;
      if (body.trim()) hashes.push("'sha256-" + btoa(String.fromCharCode(...(await sha256(utf8(body))))) + "'");
    }
  }
  const script = ["'self'", "'wasm-unsafe-eval'", ...hashes].join(' ');
  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The headers a refusal of the body limit carries (nothing else: it is answered before the rest of the app sees the request). */
export const BODY_LIMIT_HEADERS: Record<string, string> = {
  'content-type': 'application/json', connection: 'close', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
};

/** `Response.headers.setdefault` for the headers every answer gets: nosniff, referrer policy, frame ban, and no-store on the API or
 * the Content-Security-Policy elsewhere. Returns the headers with the defaults added (existing ones win, any case). */
export function withSecurityHeaders(headers: Record<string, string> | undefined, path: string, csp: string): Record<string, string> {
  const out = { ...(headers ?? {}) };
  const have = new Set(Object.keys(out).map((k) => k.toLowerCase()));
  const setdefault = (name: string, value: string) => { if (!have.has(name.toLowerCase())) out[name] = value; };
  setdefault('X-Content-Type-Options', 'nosniff');
  setdefault('Referrer-Policy', 'same-origin');
  setdefault('X-Frame-Options', 'DENY');
  if (path.startsWith('/api/')) setdefault('Cache-Control', 'no-store');
  else setdefault('Content-Security-Policy', csp);
  return out;
}

