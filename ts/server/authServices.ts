// What the Node host puts into `ctx.services` for the auth package (core never imports these): scrypt and the key file of the vault.
import { statSync } from 'node:fs';
import type { CryptoSvc } from '../core/crypto.ts';
import type { KeyFileHost } from '../core/vault.ts';
import { nodeCrypto } from './nodeCrypto.ts';
import { nodeKeyFile } from './vaultFile.ts';

export const authServices = (dbPath: string): { crypto: CryptoSvc; keyFile: KeyFileHost; dbSize: () => number } => ({
  crypto: nodeCrypto, keyFile: nodeKeyFile(dbPath),
  dbSize: () => { try { return statSync(dbPath).size; } catch { return 0; } }, // the admin overview
});
