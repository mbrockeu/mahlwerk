// Where outgoing requests may go (netguard.py, ported 1:1): public addresses only, unless an admin listed the host on purpose.
//
// Without this, any user could make the server call localhost, the LAN or a cloud metadata address, and the delivery log
// would tell open from closed ports. The target host is resolved here, EVERY address must be public, and the request is
// then sent to exactly the address that was checked (`OutRequest.address`), so a DNS answer that changes between the check
// and the connection (DNS rebinding) gains nothing. A host the admin lists in the allowed webhook hosts may be internal.
import type { Ctx } from './http.ts';
import { OutError, outgoing } from './outgoing.ts';
import { urlsplit } from './urlsplit.ts';

/** The target is not a public address (or cannot be resolved). */
export class TargetNotAllowed extends Error {}

// --- addresses as BigInt: IPv4 (32 bit) and IPv6 (128 bit) ---

type Addr = { v: 4 | 6; n: bigint };

function parseV4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255) return null; // like Python: no leading zeros
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function parseV6(text: string): bigint | null {
  let t = text;
  let tail: bigint[] = [];
  const dot = t.lastIndexOf('.');
  if (dot !== -1) { // an IPv4 tail: ::ffff:1.2.3.4
    const colon = t.lastIndexOf(':');
    const v4 = parseV4(t.slice(colon + 1));
    if (v4 === null) return null;
    tail = [v4 >> 16n, v4 & 0xffffn];
    t = t.slice(0, colon + 1) + '0:0'; // placeholder, replaced below
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string): string[] | null => (s === '' ? [] : s.split(':'));
  const head = groups(halves[0]!)!;
  const rest = halves.length === 2 ? groups(halves[1]!)! : [];
  const total = head.length + rest.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const all = halves.length === 1 ? head : [...head, ...Array(8 - total).fill('0'), ...rest];
  if (all.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  let n = 0n;
  for (const g of all) n = (n << 16n) | BigInt(parseInt(g, 16));
  if (tail.length) n = (n & ~0xffffffffn) | (tail[0]! << 16n) | tail[1]!;
  return n;
}

function parseAddress(text: string): Addr | null {
  const t = text.split('%')[0]!;
  if (t.includes(':')) {
    const n = parseV6(t);
    return n === null ? null : { v: 6, n };
  }
  const n = parseV4(t);
  return n === null ? null : { v: 4, n };
}

const net = (text: string): [bigint, number, 4 | 6] => {
  const [a, bits] = text.split('/');
  const addr = parseAddress(a!)!;
  return [addr.n, Number(bits), addr.v];
};
const inNet = (addr: Addr, [base, bits, v]: [bigint, number, 4 | 6]): boolean => {
  if (addr.v !== v) return false;
  const size = v === 4 ? 32 : 128;
  return addr.n >> BigInt(size - bits) === base >> BigInt(size - bits);
};
const inAny = (addr: Addr, nets: [bigint, number, 4 | 6][]): boolean => nets.some((n) => inNet(addr, n));

// the registries of Python 3.13 (ipaddress.py)
const V4_PRIVATE = ['0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.0.170/31',
  '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '240.0.0.0/4', '255.255.255.255/32'].map(net);
const V4_PRIVATE_EXCEPT = ['192.0.0.9/32', '192.0.0.10/32'].map(net);
const V4_SHARED = net('100.64.0.0/10');
const V4_MULTICAST = net('224.0.0.0/4');
const V6_PRIVATE = ['::1/128', '::/128', '::ffff:0.0.0.0/96', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20',
  'fc00::/7', 'fe80::/10'].map(net);
const V6_PRIVATE_EXCEPT = ['2001:1::1/128', '2001:1::2/128', '2001:3::/32', '2001:4:112::/48', '2001:20::/28', '2001:30::/28'].map(net);
const V6_RESERVED = ['::/8', '100::/8', '200::/7', '400::/6', '800::/5', '1000::/4', '4000::/3', '6000::/3', '8000::/3', 'a000::/3', 'c000::/3',
  'e000::/4', 'f000::/5', 'f800::/6', 'fe00::/9'].map(net);
const V6_MULTICAST = net('ff00::/8');
const V6_LINK_LOCAL = net('fe80::/10');
const V6_NAT64 = net('64:ff9b::/96');
const V6_MAPPED = net('::ffff:0.0.0.0/96');
const V6_6TO4 = net('2002::/16');
const V6_TEREDO = net('2001::/32');

/** The IPv4 address an IPv6 address carries (mapped, 6to4, NAT64, Teredo server), like `_embedded_v4`. */
function embeddedV4(addr: Addr): Addr | null {
  if (inNet(addr, V6_MAPPED)) return { v: 4, n: addr.n & 0xffffffffn };
  if (inNet(addr, V6_6TO4)) return { v: 4, n: (addr.n >> 80n) & 0xffffffffn };
  if (inNet(addr, V6_NAT64)) return { v: 4, n: addr.n & 0xffffffffn };
  if (inNet(addr, V6_TEREDO)) return { v: 4, n: (addr.n >> 64n) & 0xffffffffn }; // the server (teredo[0])
  return null;
}

const isPrivate = (a: Addr): boolean => a.v === 4
  ? inAny(a, V4_PRIVATE) && !inAny(a, V4_PRIVATE_EXCEPT)
  : inAny(a, V6_PRIVATE) && !inAny(a, V6_PRIVATE_EXCEPT);

export function isPublic(text: string): boolean {
  let addr = parseAddress(text);
  if (!addr) return false;
  if (addr.v === 6) addr = embeddedV4(addr) ?? addr;
  const priv = isPrivate(addr);
  if (addr.v === 4) {
    const loopback = addr.n >> 24n === 127n;
    const linkLocal = inNet(addr, net('169.254.0.0/16'));
    const reserved = inNet(addr, net('240.0.0.0/4'));
    return !priv && !inNet(addr, V4_SHARED) && !(loopback || linkLocal || inNet(addr, V4_MULTICAST) || reserved || addr.n === 0n);
  }
  const loopback = addr.n === 1n;
  return !priv && !(loopback || inNet(addr, V6_LINK_LOCAL) || inNet(addr, V6_MULTICAST) || inAny(addr, V6_RESERVED) || addr.n === 0n);
}

const OWN_TTL_MS = 60_000;
interface OwnState { cache: Map<string, { at: number; addrs: string[] }>; inflight: Map<string, Promise<string[]>> }
const ownState = new WeakMap<object, OwnState>(); // per Outgoing, so stubs never share answers

/** The addresses the server's own names resolve to. Answers (also "no such name") are cached for 60 s; a timeout or error is never remembered. Lookups of
 * one name in flight are shared. A name that definitively does not exist (OutError `connect`) counts as no address (the name check in the
 * callers still applies); a name that could not be resolved because of a timeout or error throws TargetNotAllowed: the check fails closed. */
async function ownAddresses(ctx: Ctx, names: string[]): Promise<Set<string>> {
  const out = outgoing(ctx);
  let st = ownState.get(out);
  if (!st) ownState.set(out, st = { cache: new Map(), inflight: new Map() });
  const { cache, inflight } = st;
  const ask = out.resolveOwn?.bind(out) ?? out.resolve.bind(out); // own places first: names chosen by users must not starve this check
  const all = new Set<string>();
  await Promise.all(names.map(async (name) => {
    const hit = cache.get(name);
    let addrs: string[];
    if (hit && Date.now() - hit.at <= OWN_TTL_MS) addrs = hit.addrs;
    else {
      let p = inflight.get(name);
      if (!p) {
        p = ask(name, 443).then(
          (r) => { if (r.length) cache.set(name, { at: Date.now(), addrs: r }); return r; },
          (e) => {
            // a definitive "no such name" is an answer too (remembered, so an unknown local name costs no lookup per fetch)
            if (e instanceof OutError && e.kind === 'connect') { cache.set(name, { at: Date.now(), addrs: [] }); return []; }
            console.warn(`netguard: own name ${name} could not be resolved, outgoing fetches are refused until it resolves again`);
            throw new TargetNotAllowed('own name not resolvable');
          },
        ).finally(() => inflight.delete(name));
        inflight.set(name, p);
      }
      addrs = await p;
    }
    for (const a of addrs) all.add(normalize(a));
  }));
  return all;
}

/** Same address in one spelling (IPv6 case/compression, IPv4-mapped), to compare answers of different names. */
function normalize(text: string): string {
  const a = parseAddress(text);
  if (!a) return text.toLowerCase();
  const v4 = a.v === 6 ? embeddedV4(a) : null;
  return v4 && inNet(a, V6_MAPPED) ? `4:${v4.n}` : `${a.v}:${a.n}`;
}

/** The address to connect to. Throws TargetNotAllowed for a host that does not resolve or has any non-public address
 * (unless `allowInternal`, for hosts the admin listed), or any address that one of the server's own names (`ownNames`) resolves
 * to: a public name that is routed back to the server (WAN address, hairpin NAT) is refused even when the name is not listed. */
export async function pickAddress(ctx: Ctx, host: string, port: number, allowInternal = false, ownNames: string[] = []): Promise<string> {
  let addresses: string[];
  try {
    addresses = await outgoing(ctx).resolve(host, port);
  } catch (e) {
    throw new TargetNotAllowed(String(e));
  }
  if (!addresses.length) throw new TargetNotAllowed();
  if (!allowInternal && !addresses.every(isPublic)) throw new TargetNotAllowed();
  if (ownNames.length) {
    const own = await ownAddresses(ctx, ownNames);
    if (addresses.some((a) => own.has(normalize(a)))) throw new TargetNotAllowed();
  }
  return addresses[0]!;
}

/** The host a URL names as Python reads it and the way a connection reads it must be the same, else the check above would
 * be about another host than the one that is called (`http://127.0.0.1\@public.example/`). Hardening beyond the Python code. */
export function sameHostEverywhere(url: string): boolean {
  try {
    const host = urlsplit(url).hostname;
    const whatwg = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host !== null && host.toLowerCase() === whatwg.toLowerCase();
  } catch {
    return false;
  }
}
