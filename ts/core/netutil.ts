// Small pieces of Python's standard library that the auth code leans on, ported as far as it needs them: `ipaddress`
// (strict parsing, /64 networks, IPv4-mapped addresses), Starlette's cookie reading and Set-Cookie writing.
import type { Req } from './http.ts';

export interface Ip { v: 4 | 6; bytes: number[]; zone: string }

function parseV4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p) || (p.length > 1 && p.startsWith('0'))) return null; // Python 3.9.5+: no leading zeros
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function parseV6(text: string): number[] | null {
  if (!text) return null;
  let rest = text;
  let tail: number[] = [];
  const dot = rest.lastIndexOf('.');
  if (dot !== -1) { // an IPv4 address in the last 32 bits
    const colon = rest.lastIndexOf(':');
    const v4 = parseV4(rest.slice(colon + 1));
    if (v4 === null) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    rest = rest.slice(0, colon + 1) + '0:0';
  }
  const halves = rest.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  if (head === null) return null;
  let hextets: number[];
  if (halves.length === 2) {
    const back = groups(halves[1]!);
    if (back === null || head.length + back.length > 7) return null;
    hextets = [...head, ...new Array(8 - head.length - back.length).fill(0), ...back];
  } else {
    if (head.length !== 8) return null;
    hextets = head;
  }
  if (tail.length) { hextets[6] = tail[0]!; hextets[7] = tail[1]!; }
  const bytes: number[] = [];
  for (const h of hextets) bytes.push(h >> 8, h & 255);
  return bytes;
}

/** ipaddress.ip_address(text), or null where Python raises ValueError. An IPv6 scope id (`%eth0`) is kept. */
export function parseIp(text: string): Ip | null {
  const v4 = parseV4(text);
  if (v4) return { v: 4, bytes: v4, zone: '' };
  const pct = text.indexOf('%');
  const addr = pct === -1 ? text : text.slice(0, pct);
  const zone = pct === -1 ? '' : text.slice(pct + 1);
  if (pct !== -1 && (!zone || zone.includes('%') || zone.includes('/'))) return null;
  const v6 = parseV6(addr);
  return v6 ? { v: 6, bytes: v6, zone } : null;
}

/** A string that is equal for equal addresses and never equal across the versions (IPv4 is not equal to its mapped form). */
export const ipKey = (ip: Ip): string => `${ip.v}:${ip.bytes.join('.')}${ip.zone ? '%' + ip.zone : ''}`;

const hextets = (b: number[]): number[] => Array.from({ length: 8 }, (_, i) => (b[2 * i]! << 8) | b[2 * i + 1]!);

/** str(IPv6Address): lower case, leading zeros dropped, the longest run of zero groups (two or more) as `::`. */
export function ipv6Text(h: number[]): string {
  let bestStart = -1, bestLen = 0, start = -1, len = 0;
  h.forEach((x, i) => {
    if (x === 0) { if (start === -1) { start = i; len = 0; } len++; if (len > bestLen) { bestLen = len; bestStart = start; } } else start = -1;
  });
  const hex = h.map((x) => x.toString(16));
  if (bestLen < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), else null. */
export function ipv4Mapped(ip: Ip): string | null {
  if (ip.v !== 6) return null;
  const b = ip.bytes;
  return b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255 ? b.slice(12).join('.') : null;
}

/** str(ip_network(f"{addr}/64", strict=False)) of an IPv6 address. */
export function network64(ip: Ip): string {
  const h = hextets(ip.bytes);
  return ipv6Text([h[0]!, h[1]!, h[2]!, h[3]!, 0, 0, 0, 0]) + '/64';
}

// ---- cookies -------------------------------------------------------------------------------------------------------------

/** http.cookies._unquote */
function unquote(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\([0-3][0-7][0-7])|\\(.)/gs, (_m, oct: string | undefined, ch: string | undefined) => (oct ? String.fromCharCode(parseInt(oct, 8)) : ch!));
}

/** starlette.requests.cookie_parser */
export function parseCookies(header: string): Record<string, string> {
  const jar: Record<string, string> = Object.create(null);
  for (const chunk of header.split(';')) {
    const eq = chunk.indexOf('=');
    const key = (eq === -1 ? '' : chunk.slice(0, eq)).trim();
    const val = (eq === -1 ? chunk : chunk.slice(eq + 1)).trim();
    if (key || val) jar[key] = unquote(val);
  }
  return jar;
}

const jars = new WeakMap<Req, Record<string, string>>();
export function cookiesOf(req: Req): Record<string, string> {
  let jar = jars.get(req);
  if (!jar) { jar = parseCookies(req.headers.cookie ?? ''); jars.set(req, jar); }
  return jar;
}

export interface CookieOpts { maxAge?: number; secure: boolean }

/** Response.set_cookie(name, value, max_age, path="/", httponly=True, samesite="lax", secure) as Starlette writes it. */
export function setCookieHeader(name: string, value: string, o: CookieOpts): string {
  return `${name}=${value}; HttpOnly; Max-Age=${o.maxAge}; Path=/; SameSite=lax${o.secure ? '; Secure' : ''}`;
}

/** Response.delete_cookie(name, path="/", httponly=True, samesite="lax", secure) */
export function deleteCookieHeader(name: string, secure: boolean): string {
  return `${name}=""; expires=${new Date().toUTCString()}; HttpOnly; Max-Age=0; Path=/; SameSite=lax${secure ? '; Secure' : ''}`;
}
