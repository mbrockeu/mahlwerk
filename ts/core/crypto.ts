// Crypto for core. WebCrypto (`globalThis.crypto`, in Node 22 and in browsers) does the hashing, MACs, randomness and AES-GCM.
// What it does not have – scrypt – comes from the host through `ctx.services.crypto` (Node: server/nodeCrypto.ts; an app brings
// its own). Nothing here imports node:*.
import type { Ctx } from './http.ts';

export interface CryptoSvc {
  /** scrypt (RFC 7914) with the given cost; `maxmem` is the upper bound a host with such a limit (OpenSSL) must be given. */
  scrypt(password: Uint8Array, salt: Uint8Array, n: number, r: number, p: number, dkLen: number): Promise<Uint8Array>;
}

export function cryptoSvc(ctx: Ctx): CryptoSvc {
  const svc = ctx.services.crypto as CryptoSvc | undefined;
  if (!svc) throw new Error('no crypto service configured (ctx.services.crypto)');
  return svc;
}

const enc = new TextEncoder();
export const utf8 = (text: string): Uint8Array => enc.encode(text);

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(text: string): Uint8Array | null {
  if (text.length % 2 || !/^[0-9a-fA-F]*$/.test(text)) return null;
  return Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/** base64.urlsafe_b64encode(...).rstrip("=") */
export function b64url(data: Uint8Array): string {
  let s = '';
  for (const byte of data) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64.urlsafe_b64decode(text + padding); null where Python raises binascii.Error (a length of 4n+1 or a bad padding). */
export function unb64url(text: string): Uint8Array | null {
  const body = text.replace(/[^A-Za-z0-9\-_]/g, ''); // Python's decoder skips characters outside the alphabet
  if (body.length % 4 === 1) return null;
  const s = atob(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** secrets.token_urlsafe(n): n random bytes, URL-safe base64 without padding. */
export const tokenUrlsafe = (n = 32): string => b64url(randomBytes(n));
export const tokenHex = (n: number): string => toHex(randomBytes(n));

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}
export const sha256Hex = async (text: string): Promise<string> => toHex(await sha256(utf8(text)));

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}

/** hmac.compare_digest: false for unequal lengths, otherwise no early exit. */
export function compareDigest(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const x = typeof a === 'string' ? utf8(a) : a;
  const y = typeof b === 'string' ? utf8(b) : b;
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

const aesKey = (key: Uint8Array, use: 'encrypt' | 'decrypt') => crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [use]);

/** AESGCM(key).encrypt(nonce, data, aad): ciphertext followed by the 16-byte tag. */
export async function aesGcmSeal(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const out = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 }, await aesKey(key, 'encrypt'), data as BufferSource);
  return new Uint8Array(out);
}

/** The plain text, or null when the tag does not fit (wrong key, other AAD, damaged data). */
export async function aesGcmOpen(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null> {
  try {
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 }, await aesKey(key, 'decrypt'), data as BufferSource);
    return new Uint8Array(out);
  } catch { return null; }
}
