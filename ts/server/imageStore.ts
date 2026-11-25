// The picture folder (imagestore.py): files in `<database file name>.images` next to the database.
//
// Files are written to a temporary name and moved into place (a half-written file is never visible), mode 0600 in a 0700 folder. The
// folder is only ever touched when it is OURS: Mahlwerk makes it itself and puts a marker file in it. A folder that exists without the
// marker (and is not empty) is never changed, tidied or written to: the answer is a clear error instead. The total size is limited
// (MAHLWERK_IMAGES_MAX_MB, default 1024).
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, unlinkSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { SIZES, type Processed } from '../core/imageproc.ts';
import { StoreError, validHash, validSize, type ImageFiles } from '../core/imagestore.ts';

const DEFAULT_MAX_MB = 1024;
const SWEEP_LIMIT = 2000;
const GRACE_SECONDS = 3600;
const NAME = /^([0-9a-f]{32})-([lms])\.webp$/;
const DAY = 86400;
const MARKER = '.mahlwerk-images';
const TMP_PREFIX = '.mahlwerk-tmp-';

export function maxBytesFromEnv(env: Record<string, string | undefined>): number {
  const raw = (env.MAHLWERK_IMAGES_MAX_MB ?? '').trim();
  let value = raw ? Number(raw) : DEFAULT_MAX_MB;
  if (!Number.isFinite(value)) value = DEFAULT_MAX_MB;
  return Math.floor(Math.max(1, value) * 1024 * 1024);
}

export const imageFolder = (dbPath: string): string => join(dirname(dbPath), basename(dbPath) + '.images');

export function nodeImageStore(dir: string, maxBytes: number, clock: () => number = () => Date.now() / 1000): ImageFiles {
  let lastSweep = clock();
  const pathOf = (digest: string, size: string): string | null => (validHash(digest) && validSize(size) ? join(dir, `${digest}-${size}.webp`) : null);
  const ours = (): boolean => existsSync(join(dir, MARKER)) && statSync(join(dir, MARKER)).isFile();

  function ensure(): void {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      else if (!ours() && readdirSync(dir).length) throw new StoreError('the picture folder exists but was not made by Mahlwerk (marker file missing): it is left alone');
      if (!ours()) {
        chmodSync(dir, 0o700);
        writeFileSync(join(dir, MARKER), 'Mahlwerk recipe pictures: files named <hash>-<size>.webp. Back this folder up with the database.\n');
      }
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError('the picture folder cannot be written (disk full or no permission)');
    }
  }

  /** (path, size, mtime in seconds) of every picture file (and leftover temporary files). */
  function entries(): [string, number, number][] {
    if (!ours()) return [];
    const found: [string, number, number][] = [];
    try {
      for (const name of readdirSync(dir)) {
        if (!NAME.test(name) && !name.startsWith(TMP_PREFIX)) continue;
        const st = lstatSync(join(dir, name));
        if (st.isFile()) found.push([join(dir, name), st.size, st.mtimeMs / 1000]);
      }
    } catch { /* a folder that is gone has no pictures */ }
    return found;
  }

  const total = () => entries().reduce((n, e) => n + e[1], 0);
  const has = (digest: string) => Object.keys(SIZES).every((s) => { const p = pathOf(digest, s); return p !== null && existsSync(p) && statSync(p).isFile(); });

  return {
    async read(digest, size) {
      const p = pathOf(digest, size);
      if (p === null) return null;
      try { return new Uint8Array(readFileSync(p)); } catch { return null; }
    },
    async has(digest) { return has(digest); },
    async put(processed: Processed) {
      if (has(processed.hash)) return;
      const added = Object.values(processed.files).reduce((n, b) => n + b.length, 0);
      ensure();
      if (total() + added > maxBytes) throw new StoreError('the picture folder is full (limit MAHLWERK_IMAGES_MAX_MB): remove pictures or raise the limit');
      const made: string[] = [];
      try {
        for (const [key, data] of Object.entries(processed.files)) {
          const target = pathOf(processed.hash, key)!;
          const tmp = join(dir, TMP_PREFIX + randomBytes(8).toString('hex'));
          try {
            const fd = openSync(tmp, 'wx', 0o600);
            try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
            renameSync(tmp, target);
            made.push(target);
          } catch (e) {
            try { unlinkSync(tmp); } catch { /* not there */ }
            throw e;
          }
        }
      } catch {
        for (const p of made) { try { unlinkSync(p); } catch { /* gone */ } } // an incomplete set is never left behind
        throw new StoreError('the picture could not be written (disk full or no permission)');
      }
    },
    async delete(digest) {
      for (const key of Object.keys(SIZES)) {
        const p = pathOf(digest, key);
        if (p !== null) { try { unlinkSync(p); } catch { /* not there */ } }
      }
    },
    async sweep(referenced, limit = SWEEP_LIMIT) {
      const now = clock();
      let removed = 0;
      lastSweep = now;
      for (const [path, , mtime] of entries().sort((a, b) => a[2] - b[2])) {
        if (removed >= limit) break;
        if (now - mtime < GRACE_SECONDS) continue;
        const m = NAME.exec(basename(path));
        if (m === null || !referenced.has(m[1]!)) {
          try { unlinkSync(path); removed++; } catch { /* gone */ }
        }
      }
      return removed;
    },
    sweepDue: () => clock() - lastSweep >= DAY,
  };
}
