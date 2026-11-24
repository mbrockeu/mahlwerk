// Stored secrets: connector credentials kept encrypted in the database (vault.py). The same format as the Python side, so that
// either server reads what the other wrote.
//
// AES-256-GCM, a fresh random 96-bit nonce per value, the row's owner and name bound in as associated data
// (`mahlwerk:<user_id>:<name>`), blob = 0x01 | nonce | ciphertext+tag. The key is MAHLWERK_SECRET_KEY (at least 32 characters)
// stretched with scrypt (N=2^15, r=8, p=1) and the random salt in the database (`setting` row `secret.vault_salt`); otherwise a key
// file next to the database (`<database>.key`, 32 random bytes as hex, mode 0600, created without overwriting, only when the first
// secret is stored). The environment variable takes precedence over the file.
//
// A missing or wrong key is not an error for the rest of the app: the stored secret then counts as "not there" (state `unreadable`).
// Nothing is ever returned, logged or put into an error message except the state names defined here.
//
// The key file is the host's business (core has no file system): `ctx.services.keyFile`.
import { aesGcmOpen, aesGcmSeal, cryptoSvc, fromHex, randomBytes, tokenHex, utf8 } from './crypto.ts';
import type { Ctx } from './http.ts';
import { deleteSecret, getSecret, hasSecret, putSecret, vaultSalt } from './store/globals.ts';

export const HOUSEHOLD = 0;
const VERSION = 1;
export const ENV_NAME = 'MAHLWERK_SECRET_KEY';
const MIN_ENV_LENGTH = 32;
const SCRYPT = { n: 2 ** 15, r: 8, p: 1 };

/** The key file of the host. `read`: its text and mode, null when there is none, false when it cannot be read. `create` writes it
 * without ever replacing an existing one (null when it could not be made). */
export interface KeyFileHost {
  read(): Promise<{ text: string; mode: number } | null | false>;
  create(hex: string): Promise<boolean>;
}

/** Storing is impossible; `code` is `invalid_key` or `no_key_file`. Carries no secret. */
export class VaultError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

/** `a***@example.org`: enough to recognise the account, not enough to use it. */
export function maskEmail(email: string): string {
  const text = email || '';
  const at = text.indexOf('@');
  const domain = at < 0 ? '' : text.slice(at + 1);
  return domain ? `${[...text.slice(0, at)][0] ?? ''}***@${domain}` : '***';
}

export class Vault {
  private ctx: Ctx;
  private derived: { raw: string; salt: string; key: Uint8Array } | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(ctx: Ctx) { this.ctx = ctx; }

  private get keyFile(): KeyFileHost | undefined { return this.ctx.services.keyFile as KeyFileHost | undefined; }

  /** The key from the environment, null if the variable is not set, false if it is set but unusable. */
  private async envKey(): Promise<Uint8Array | null | false> {
    const raw = this.ctx.env[ENV_NAME] ?? '';
    if (!raw.trim()) return null;
    if ([...raw].length < MIN_ENV_LENGTH) return false;
    const salt = await vaultSalt(this.ctx.db);
    const saltHex = Array.from(salt, (b) => b.toString(16).padStart(2, '0')).join('');
    if (this.derived && this.derived.raw === raw && this.derived.salt === saltHex) return this.derived.key;
    const key = await cryptoSvc(this.ctx).scrypt(utf8(raw), salt, SCRYPT.n, SCRYPT.r, SCRYPT.p, 32);
    this.derived = { raw, salt: saltHex, key };
    return key;
  }

  /** The key from the key file, null if there is none, false if it is not a valid key file. */
  private async fileKey(): Promise<Uint8Array | null | false> {
    const host = this.keyFile;
    if (!host) return null;
    const file = await host.read();
    if (file === null || file === false) return file;
    const key = fromHex(file.text.trim().replace(/\s+/g, ''));
    return key && key.length === 32 ? key : false;
  }

  /** `env`, `file`, `none` (nothing yet: made when the first secret is stored) or `invalid`. */
  async keyStatus(): Promise<string> {
    const env = await this.envKey();
    if (env !== null) return env === false ? 'invalid' : 'env';
    const file = await this.fileKey();
    return file === null ? 'none' : file === false ? 'invalid' : 'file';
  }

  private async readKey(): Promise<Uint8Array | null> {
    const env = await this.envKey();
    if (env !== null) return env || null;
    return (await this.fileKey()) || null;
  }

  private async keyForWriting(): Promise<Uint8Array> {
    const run = async (): Promise<Uint8Array> => {
      const env = await this.envKey();
      if (env === false) throw new VaultError('invalid_key');
      if (env !== null) return env;
      let file = await this.fileKey();
      if (file === false) throw new VaultError('invalid_key'); // never overwrite a file we cannot read
      if (file === null) {
        if (!this.keyFile || !(await this.keyFile.create(tokenHex(32)))) throw new VaultError('no_key_file');
        file = await this.fileKey();
      }
      if (!file) throw new VaultError('invalid_key');
      return file;
    };
    const turn = this.lock.then(run, run);
    this.lock = turn.catch(() => undefined);
    return turn;
  }

  private static aad = (userId: number, name: string): Uint8Array => utf8(`mahlwerk:${userId}:${name}`);

  async put(userId: number, name: string, value: Record<string, unknown>): Promise<void> {
    const key = await this.keyForWriting();
    const nonce = randomBytes(12);
    const data = await aesGcmSeal(key, nonce, utf8(JSON.stringify(value)), Vault.aad(userId, name));
    const blob = new Uint8Array(1 + 12 + data.length);
    blob[0] = VERSION;
    blob.set(nonce, 1);
    blob.set(data, 13);
    await putSecret(this.ctx.db, userId, name, blob);
  }

  /** The stored value, or null when there is none or it cannot be read with the current key. */
  async get(userId: number, name: string): Promise<Record<string, unknown> | null> {
    const blob = await getSecret(this.ctx.db, userId, name);
    if (blob === null) return null;
    const key = await this.readKey();
    if (key === null || blob[0] !== VERSION || blob.length < 1 + 12 + 16) return null;
    const plain = await aesGcmOpen(key, blob.slice(1, 13), blob.slice(13), Vault.aad(userId, name));
    if (plain === null) return null;
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }

  /** `none`, `stored` or `unreadable` (a value is there but the key is missing or does not fit). */
  async state(userId: number, name: string): Promise<string> {
    if (!(await hasSecret(this.ctx.db, userId, name))) return 'none';
    return (await this.get(userId, name)) !== null ? 'stored' : 'unreadable';
  }

  async delete(userId: number, name: string): Promise<void> {
    await deleteSecret(this.ctx.db, userId, name);
  }
}
