// Password hashing with scrypt (passwords.py). A hash is the text `scrypt$N$r$p$salt$key` (salt and key in unpadded URL-safe
// base64), the same text the Python server writes and reads. The cost travels with the hash; a hash made with weaker parameters
// than the current ones is replaced at the next successful sign-in (`needsRehash`).
import { b64url, compareDigest, cryptoSvc, randomBytes, unb64url, utf8 } from './crypto.ts';
import type { Ctx } from './http.ts';

export const MIN_LENGTH = 10;
export const MAX_LENGTH = 256; // also keeps a huge body from being hashed

// Production cost: 2**15 needs about 32 MB of memory and 80 ms per hash. Nothing in the environment lowers it; only code (the
// `cost` argument of the test host) can.
export const DEFAULT_COST: [number, number, number] = [2 ** 15, 8, 1];
const SALT_BYTES = 16;
const KEY_BYTES = 32;
// Hashes stored in the database are trusted, but their parameters are still bounded before they reach scrypt.
const LIMIT_N = 2 ** 20, LIMIT_R = 32, LIMIT_P = 16;
// At most this many hashes run at once, so a flood of sign-in attempts cannot use up the memory (4 x 32 MB).
const CONCURRENT = 4;

class Slots {
  private free = CONCURRENT;
  private waiting: (() => void)[] = [];
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try { return await fn(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.free++;
    }
  }
}

interface Parsed { n: number; r: number; p: number; salt: Uint8Array; key: Uint8Array }

const PY_INT = /^\s*[+-]?\d+(_\d+)*\s*$/;

export class PasswordHasher {
  private n: number;
  private r: number;
  private p: number;
  private slots = new Slots();
  private dummyHash: Promise<string> | null = null;
  private ctx: Ctx;

  constructor(ctx: Ctx, cost: [number, number, number] = DEFAULT_COST) {
    this.ctx = ctx;
    [this.n, this.r, this.p] = cost;
  }

  private scrypt(password: string, salt: Uint8Array, n: number, r: number, p: number): Promise<Uint8Array> {
    return cryptoSvc(this.ctx).scrypt(utf8(password), salt, n, r, p, KEY_BYTES);
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await this.slots.use(() => this.scrypt(password, salt, this.n, this.r, this.p));
    return `scrypt$${this.n}$${this.r}$${this.p}$${b64url(salt)}$${b64url(key)}`;
  }

  static parse(stored: string): Parsed | null {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt' || !parts.slice(1, 4).every((x) => PY_INT.test(x))) return null;
    const [n, r, p] = parts.slice(1, 4).map((x) => Number(x.replace(/_/g, ''))) as [number, number, number];
    if (!(n >= 2 && n <= LIMIT_N && (n & (n - 1)) === 0 && r >= 1 && r <= LIMIT_R && p >= 1 && p <= LIMIT_P)) return null;
    const salt = unb64url(parts[4]!);
    const key = unb64url(parts[5]!);
    if (!salt || !key) return null;
    return { n, r, p, salt, key };
  }

  /** Compare in constant time. A missing or malformed hash costs the same work and gives false. */
  async verify(password: string, stored: string | null | undefined): Promise<boolean> {
    let parsed = stored ? PasswordHasher.parse(stored) : null;
    let expectedOk = true;
    if (parsed === null) {
      parsed = PasswordHasher.parse(await this.dummy())!;
      expectedOk = false;
    }
    const { n, r, p, salt, key } = parsed;
    const candidate = await this.slots.use(() => this.scrypt(password, salt, n, r, p));
    return compareDigest(candidate, key) && expectedOk;
  }

  needsRehash(stored: string): boolean {
    const parsed = PasswordHasher.parse(stored);
    return parsed === null || parsed.n !== this.n || parsed.r !== this.r || parsed.p !== this.p;
  }

  /** A hash nobody knows the password of, with the current cost: used to spend the same time when the account does not exist. */
  dummy(): Promise<string> {
    this.dummyHash ??= (async () => {
      const salt = randomBytes(SALT_BYTES);
      const key = await this.scrypt(b64url(randomBytes(18)), salt, this.n, this.r, this.p);
      return `scrypt$${this.n}$${this.r}$${this.p}$${b64url(salt)}$${b64url(key)}`;
    })();
    return this.dummyHash;
  }
}
