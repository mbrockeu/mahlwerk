// The key of the vault in the app (server: the key file next to the database, server/vaultFile.ts). The native side keeps 32 random
// bytes in this device's keychain, made once at the first `{op:"secretKey"}` and never in the database or the export: stored
// secrets (connector credentials) therefore do not move to another device, they are entered again there.
import { fromB64, type Bridge } from './bridge.ts';
import type { KeyFileHost } from '../core/vault.ts';

export function bridgeKeyFile(bridge: Bridge): KeyFileHost {
  let hex: string | null = null;
  return {
    async read() {
      if (hex) return { text: hex, mode: 0o600 };
      let key: Uint8Array;
      try { key = fromB64(String((await bridge({ op: 'secretKey' }))?.keyB64 ?? '')); } catch { return false; }
      if (key.length !== 32) return false; // not a usable key: the vault refuses to store (never makes one of its own)
      hex = Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('');
      return { text: hex, mode: 0o600 };
    },
    async create() { return false; }, // the keychain key is made by the native side; read() never answers "none"
  };
}
