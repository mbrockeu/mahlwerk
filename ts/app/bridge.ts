// The native side of the app as the app host sees it: one call that sends a message and gets the answer (WKWebView:
// `window.webkit.messageHandlers.mahlwerkNative.postMessage(msg)`, a handler with reply). A failure arrives as a rejected promise
// whose message is the native error text (SQLite: sqlite3_errmsg; http: starts with `timeout`, `too_large` or `connect`).
// The contract (ops and shapes) is described in ts/PORTING.md, section "App-Host".

export type Bridge = (msg: Record<string, unknown>) => Promise<any>;

/** Standard base64 (with padding), the encoding of BLOBs and HTTP bodies on the bridge. */
export function toB64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The text of a rejection (an Error from WebKit, or whatever a fake bridge throws). */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
