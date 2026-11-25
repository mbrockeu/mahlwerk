// The key file of the vault (vault.py): `<database>.key`, 32 random bytes as hex, mode 0600, never replaced once it exists.
import { chmodSync, closeSync, constants, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { KeyFileHost } from '../core/vault.ts';

export function nodeKeyFile(dbPath: string): KeyFileHost {
  const path = dbPath + '.key';
  let warned = false;
  return {
    async read() {
      try {
        const bytes = readFileSync(path);
        const mode = statSync(path).mode;
        if (bytes.some((b) => b > 127)) return false; // not ASCII
        if (mode & 0o077 && !warned) { // readable by others: say so once, do not refuse
          warned = true;
          console.warn(`the key file for stored secrets is readable by group or others (mode ${(mode & 0o777).toString(8)}): chmod 600 it`);
        }
        return { text: bytes.toString('ascii'), mode };
      } catch (e: any) {
        return e?.code === 'ENOENT' ? null : false;
      }
    },
    /** Written next to it and hard-linked into place: an existing file is never replaced. */
    async create(hex: string) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = join(dirname(path), `${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
        const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          writeSync(fd, hex + '\n');
          fsyncSync(fd);
        } finally { closeSync(fd); }
        try {
          try { linkSync(tmp, path); } catch (e: any) {
            if (e?.code === 'EEXIST') { /* somebody else made it a moment ago: theirs stays */ } else {
              try { // a file system without hard links: create the target itself, again without replacing anything
                const fd2 = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
                try { writeSync(fd2, hex + '\n'); fsyncSync(fd2); } finally { closeSync(fd2); }
              } catch (e2: any) { if (e2?.code !== 'EEXIST') throw e2; }
            }
          }
        } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
        try { chmodSync(path, 0o600); } catch { /* not ours */ }
        return true;
      } catch { return false; }
    },
  };
}
