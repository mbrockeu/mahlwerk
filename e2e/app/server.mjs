// FOR TESTS: serves the app build (web/dist-app) like the iOS app's web view would load it, plus the fake native side (/__fake/: the
// SharedWorker, SQLite WASM from node_modules, the BLS fixture). No API here: the page answers it itself.
// Usage: node --experimental-strip-types server.mjs <port>
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { buildBlsFixture } from '../../ts/tests/appBridge.ts';

const here = new URL('.', import.meta.url).pathname;
const dist = join(here, '../../web/dist-app');
const sqlite = join(here, '../node_modules/@sqlite.org/sqlite-wasm/dist');
const bls = join(mkdtempSync(join(tmpdir(), 'mw-app-bls-')), 'bls.db');
buildBlsFixture(bls);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function file(path) {
  if (path === '/__fake/worker.mjs') return join(here, 'worker.mjs');
  if (path === '/__fake/bls.db') return bls;
  if (path.startsWith('/__fake/sqlite/')) return join(sqlite, normalize(path.slice('/__fake/sqlite/'.length)).replace(/^(\.\.[/\\])+/, ''));
  if (path.startsWith('/__fake/')) return null;
  const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
  return join(dist, rel || 'index.html');
}

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const f = file(path);
  if (!f || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(Number(process.argv[2]), '127.0.0.1', () => console.log('app test server up'));
