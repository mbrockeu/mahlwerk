// The Node side of core/crypto.ts: scrypt from node:crypto (OpenSSL).
import { scrypt } from 'node:crypto';
import type { CryptoSvc } from '../core/crypto.ts';

export const nodeCrypto: CryptoSvc = {
  scrypt: (password, salt, n, r, p, dkLen) => new Promise((resolve, reject) =>
    // OpenSSL refuses to go over 32 MB by default, which N=2**15, r=8 touches exactly: give it room (like passwords.py)
    scrypt(password, salt, dkLen, { N: n, r, p, maxmem: 256 * n * r * p + 2 ** 20 }, (err, key) => (err ? reject(err) : resolve(new Uint8Array(key))))),
};
