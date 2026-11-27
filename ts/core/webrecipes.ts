// Recipes from web pages (webrecipes.py): the address of a recipe goes in, name, portions and nutrition per portion come out.
//
// What is read: the structured data a page carries for search engines (schema.org `Recipe` as JSON-LD in
// `<script type="application/ld+json">`, also inside `@graph` and lists, `@type` as text or list). Microdata is NOT read.
// What is kept: name, number of portions, nutrition values per portion, the address and the host. Never kept or shown: preparation
// steps, descriptions (copyright). The ONE picture the page names is fetched and stored only when an admin switched "store recipe
// pictures" on for this connector (default off), and it is fetched like the page itself.
//
// The fetch is the sensitive part, because the server calls an address a signed-in person typed:
//   * only http/https, no user name or password, only the standard ports 80 and 443, a host name (no IP literal),
//   * the host is resolved here, EVERY address must be public (netguard; there is no exception list for this feature) and the
//     connection goes to exactly the address that was checked (no DNS rebinding between check and connect),
//   * redirects are followed by hand, at most 3, every station is checked again, https to http is refused,
//   * 10 seconds for everything, at most 3 MB of (decompressed) body, counted while it arrives; only text/html and
//     application/xhtml+xml; gzip/deflate are inflated with a bound, so a compression bomb stops at the limit,
//   * a picture the same way: at most 6 MB, only image/jpeg, image/png and image/webp,
//   * no cookies, no Referer, a fixed User-Agent with project name and contact,
//   * every problem on the way gives the same text, so the feature cannot tell an inside from an outside or an open from a closed port,
//   * a brake per person and one for the server, and at most 3 fetches at the same time.
// Whatever comes back is text: tags and control characters are removed and every length is limited.
import type { Ctx } from './http.ts';
import { unescapeHtml } from './htmlEntities.ts';
import { pickAddress, TargetNotAllowed } from './netguard.ts';
import { OutError, outgoing } from './outgoing.ts';
import { roundHalfEven } from './num.ts';
import { urlsplit } from './urlsplit.ts';

export const SOURCE = 'web';
export const EXTERNAL_PREFIX = 'web:';
export const BRAND_PREFIX = 'Web · '; // the brand of a taken-over web recipe; an entry keeps only its brand, so this is how it is recognised
export const REFERENCE_AMOUNT = 100.0; // g: one portion is stored as 100 g whose "per 100 g" values are the values of the portion

const TOTAL_TIMEOUT = 10.0; // seconds for the whole fetch (all stations)
const MAX_BYTES = 3 * 1024 * 1024; // decompressed
const MAX_REDIRECTS = 3;
const MAX_URL = 800;
const PORTS = [80, 443];
const CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // a picture, as sent (a compressed answer is counted decompressed)
const MAX_BLOCKS = 40; // JSON-LD blocks read per page
const MAX_BLOCK_BYTES = 1024 * 1024;
const MAX_TAGS = 20_000; // script tags and comments looked at per page (a real page has a few hundred)
const MAX_NODES = 3000; // objects looked at while searching for the recipe
const MAX_QUEUE = 100_000; // values (objects, lists, everything else) taken from the queue while searching
const MAX_DEPTH = 6;
const MAX_INGREDIENTS = 100;
export const MAX_NAME = 200;
const MAX_LINE = 200;
const MAX_KCAL = 5000.0; // per portion; more means a unit error (or the whole recipe)
const MAX_GRAMS = 500.0;
export const MAX_PORTIONS = 200.0;
const KJ_PER_KCAL = 4.184;
const SALT_PER_SODIUM = 2.5;

export const NEUTRAL = 'the page could not be fetched'; // THE text for everything that goes wrong on the way

const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_ga|_gl|yclid|twclid|ttclid|wbraid|gbraid|ref_src|ref_url|spm|si)$/i;
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

/** The text is not an address this feature will fetch. */
export class LinkRejected extends Error {}

/** Anything that went wrong on the way. `kind` is for the logs and tests only, the person always gets NEUTRAL, except `not_html` and
 * `too_large`, which are only known after a connection to a public address. */
export class FetchFailed extends Error {
  kind: string;
  constructor(kind: string) { super(kind); this.kind = kind; }
}

const chars = (s: string): string[] => Array.from(s);
/** The first `n` code points (only the head is split: 2n code units hold at least n code points). */
const cut = (s: string, n: number): string => (s.length <= n ? s : chars(s.slice(0, 2 * n)).slice(0, n).join(''));
const isDigits = (s: string): boolean => /^[0-9]+$/.test(s);
const cmp = (a: string, b: string): number => { // Python compares by code point
  const x = chars(a), y = chars(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
  return x.length - y.length;
};

// ---- addresses ----

function hostOk(input: string): string {
  const host = input.trim().replace(/\.+$/, '').toLowerCase();
  if (!host || host.length > 253 || /[ /\\@#?%[\]:]/.test(host)) throw new LinkRejected('host');
  let ascii: string;
  try {
    ascii = new URL('http://' + host).hostname; // IDNA (punycode) as the platform knows it
  } catch {
    throw new LinkRejected('host');
  }
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) throw new LinkRejected('host');
  if (!/^[a-z0-9-]+$/.test(labels.join('').replaceAll('-', 'a')) || !/[a-z]/.test(labels.at(-1)!)) throw new LinkRejected('host'); // a number-like name is an IP literal in disguise
  return ascii;
}

function parseQsl(query: string): [string, string][] {
  const parts = query.split('&');
  if (parts.length > 60) throw new RangeError('Max number of fields exceeded');
  const dec = (s: string): string => {
    const t = s.replace(/\+/g, ' ');
    try { return decodeURIComponent(t); } catch { return t.replace(/%([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))); }
  };
  const out: [string, string][] = [];
  for (const p of parts) {
    if (!p) continue;
    const i = p.indexOf('=');
    out.push(i === -1 ? [dec(p), ''] : [dec(p.slice(0, i)), dec(p.slice(i + 1))]);
  }
  return out;
}

const quotePlus = (s: string): string => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');

/** [normalised address, ascii host, port] of an address this feature may fetch, else LinkRejected.
 * Normal form (so the same page is never taken over twice): scheme and host in lower case, the standard port dropped, no fragment,
 * tracking parameters removed, the remaining parameters sorted, an empty path is `/`. */
export function checkAddress(input: string): [string, string, number] {
  const url = (input ?? '').trim();
  if (!url || chars(url).length > MAX_URL || chars(url).some((c) => CONTROL.test(c) || /\s/.test(c))) throw new LinkRejected('form');
  let parts, port, host;
  try {
    parts = urlsplit(url);
    port = parts.port;
    host = parts.hostname;
  } catch {
    throw new LinkRejected('form');
  }
  const scheme = parts.scheme.toLowerCase();
  if ((scheme !== 'http' && scheme !== 'https') || !host) throw new LinkRejected('scheme');
  if (parts.username !== null || parts.password !== null || parts.netloc.includes('@')) throw new LinkRejected('userinfo');
  if (port !== null && !PORTS.includes(port)) throw new LinkRejected('port');
  const asciiHost = hostOk(host);
  const path = parts.path || '/';
  let query: string;
  try {
    const pairs = parseQsl(parts.query).filter(([k]) => !TRACKING.test(k)).sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
    query = pairs.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join('&');
  } catch {
    throw new LinkRejected('query'); // more than 60 parameters, odd escapes
  }
  const std = scheme === 'https' ? 443 : 80;
  const explicit = port !== null && port !== std ? `:${port}` : '';
  return [`${scheme}://${asciiHost}${explicit}${path.startsWith('/') ? path : '/' + path}${query ? '?' + query : ''}`, asciiHost, port ?? std];
}

/** `web:<host><path>?<query>`: the scheme is left out, so http and https of one page are one recipe. */
export function externalId(address: string): string {
  const parts = urlsplit(address);
  return EXTERNAL_PREFIX + `//${parts.netloc}${parts.path}${parts.query ? '?' + parts.query : ''}`.replace(/^\/+/, '');
}

/** The host to show: without `www.`, always in its ASCII form (an international name shows as `xn--...`, never as look-alike letters). */
export function hostLabel(address: string): string {
  let host = '';
  try { host = urlsplit(address).hostname ?? ''; } catch { /* no host */ }
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** The stored address as a link: only an http(s) address that passes the same check, else null (never `javascript:` etc.). */
export function safeLink(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try { return checkAddress(url)[0]; } catch { return null; }
}

// ---- the brake ----

/** At most `perUser` fetches per person and `total` for the server within `window` seconds, at most `parallel` at once. In the memory of this process. */
export class Brake {
  clock: () => number;
  private perUser: number;
  private total: number;
  private window: number;
  private users = new Map<number, number[]>();
  private all: number[] = [];
  private free: number;

  constructor(clock: () => number = () => Date.now() / 1000, perUser = 20, total = 60, window = 600.0, parallel = 3) {
    this.clock = clock; this.perUser = perUser; this.total = total; this.window = window; this.free = parallel;
  }

  private trim(queue: number[], now: number): void { while (queue.length && queue[0]! <= now - this.window) queue.shift(); }

  /** 0 = go ahead (and counted), else the seconds to wait. */
  allow(userId: number): number {
    const now = this.clock();
    let mine = this.users.get(userId);
    if (!mine) this.users.set(userId, (mine = []));
    this.trim(mine, now);
    this.trim(this.all, now);
    for (const [queue, limit] of [[mine, this.perUser], [this.all, this.total]] as const) {
      if (queue.length >= limit) return Math.max(1, Math.trunc(queue[0]! + this.window - now) + 1);
    }
    mine.push(now);
    this.all.push(now);
    if (this.users.size > 5000) { // bound on memory: forget people who have nothing in the window
      for (const [k, q] of this.users) if (!q.length || q.at(-1)! <= now - this.window) this.users.delete(k);
    }
    return 0;
  }

  slot(): boolean { if (this.free <= 0) return false; this.free--; return true; }
  release(): void { this.free++; }
}

// ---- fetching ----

async function inflate(data: Uint8Array, format: 'gzip' | 'deflate' | 'deflate-raw', limit: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new FetchFailed('too_large'); }
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof FetchFailed) throw e;
    throw new FetchFailed('encoding');
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The body, decompressed, at most `limit` (a compression bomb stops at the limit, counted on what comes out). */
async function readBody(headers: Record<string, string>, raw: Uint8Array, limit: number): Promise<Uint8Array> {
  const length = headers['content-length'];
  if (length && isDigits(length) && Number(length) > limit) throw new FetchFailed('too_large');
  if (raw.length > limit) throw new FetchFailed('too_large');
  const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') return raw;
  if (encoding === 'gzip' || encoding === 'x-gzip') return inflate(raw, 'gzip', limit);
  if (encoding === 'deflate') { // zlib-wrapped as the standard says, or raw as some servers send it
    const zlibHeader = raw.length >= 2 && (raw[0]! & 0x0f) === 8 && (raw[0]! * 256 + raw[1]!) % 31 === 0;
    return inflate(raw, zlibHeader ? 'deflate' : 'deflate-raw', limit);
  }
  throw new FetchFailed('encoding');
}

// Text encodings that are read. Anything else a page names is read as UTF-8 (wrong letters at worst): a name is NEVER looked up as a
// codec by whatever the page says.
const CHARSETS: Record<string, string> = {
  'utf-8': 'utf-8', utf8: 'utf-8', 'us-ascii': 'windows-1252', ascii: 'windows-1252',
  'iso-8859-1': 'windows-1252', latin1: 'windows-1252', 'latin-1': 'windows-1252', l1: 'windows-1252',
  'iso-8859-15': 'iso-8859-15', 'latin-9': 'iso-8859-15', latin9: 'iso-8859-15',
  'windows-1252': 'windows-1252', cp1252: 'windows-1252', 'iso-8859-2': 'iso-8859-2', 'windows-1250': 'windows-1250', cp1250: 'windows-1250',
};

function charsetOf(contentType: string, head: string): string {
  const m = /charset\s*=\s*["']?([A-Za-z0-9_.:-]{1,40})/i.exec(contentType) ?? /<meta[^>]{0,200}charset\s*=\s*["']?([A-Za-z0-9_.:-]{1,40})/i.exec(head);
  return CHARSETS[(m ? m[1]! : 'utf-8').toLowerCase()] ?? 'utf-8';
}

export function decode(body: Uint8Array, contentType: string): string {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return new TextDecoder('utf-8').decode(body.subarray(3));
  if (body[0] === 0xff && body[1] === 0xfe) return new TextDecoder('utf-16le').decode(body.subarray(2)); // only with a byte order mark
  if (body[0] === 0xfe && body[1] === 0xff) return new TextDecoder('utf-16be').decode(body.subarray(2));
  const head = new TextDecoder('latin1').decode(body.subarray(0, 2048));
  return new TextDecoder(charsetOf(contentType, head)).decode(body);
}

export interface Page { url: string; text: string; data: Uint8Array }

/** Names that may not be fetched: MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS, the host of MAHLWERK_PUBLIC_URL and the names in
 * MAHLWERK_ALLOWED_HOSTS (the server's own names). An entry blocks the name and all its subdomains. */
export function blockedHosts(env: Record<string, string | undefined>): string[] {
  const names: string[] = [...(env.MAHLWERK_WEB_RECIPES_BLOCKED_HOSTS ?? '').split(','), ...(env.MAHLWERK_ALLOWED_HOSTS ?? '').split(',')];
  const pub = (env.MAHLWERK_PUBLIC_URL ?? '').trim();
  if (pub) { try { names.push(urlsplit(pub).hostname ?? ''); } catch { /* not a URL */ } }
  const out: string[] = [];
  for (let name of names) {
    name = name.trim().toLowerCase().replace(/^\*+/, '').replace(/^\.+/, '').replace(/\.+$/, '');
    const bracketed = /^\[([^\]]*)\](?::\d*)?$/.exec(name); // an IPv6 literal, with or without a port: [::1]:8110
    if (bracketed) name = bracketed[1]!;
    else if ((name.match(/:/g) ?? []).length === 1) name = name.split(':')[0]!;
    if (name && name !== '*' && !out.includes(name)) out.push(name);
  }
  return out;
}

export function isBlocked(host: string, blocked: string[]): boolean {
  let end = host.length;
  while (end && host[end - 1] === '.') end--; // trailing dots, without a `\.+$` scan from every dot of a long name
  const h = host.slice(0, end).toLowerCase();
  return blocked.some((b) => h === b || h.endsWith('.' + b));
}

/** Fetches one page by the rules in the module text. The whole fetch of an address (name resolution, connecting, TLS, headers, body
 * and all redirects) is waited for at most `totalTimeout` seconds. At most `maxWorkers` fetches exist at the same time (hung ones
 * count), so they cannot pile up; a further fetch then fails at once. */
export class Fetcher {
  ctx: Ctx;
  userAgent: string;
  totalTimeout: number;
  clock: () => number;
  private free: number;

  constructor(ctx: Ctx, userAgent: string, totalTimeout = TOTAL_TIMEOUT, maxWorkers = 8, clock: () => number = () => performance.now() / 1000) {
    this.ctx = ctx; this.userAgent = userAgent; this.totalTimeout = totalTimeout; this.free = maxWorkers; this.clock = clock;
  }

  blocked(): string[] { return blockedHosts(this.ctx.env); }

  fetch(address: string): Promise<Page> { return this.run(address, false); }
  /** A picture (JPEG, PNG or WebP, at most MAX_IMAGE_BYTES) by the same rules as a page; `Page.data` holds the bytes. */
  fetchImage(address: string): Promise<Page> { return this.run(address, true); }

  private async run(address: string, image: boolean): Promise<Page> {
    if (this.free <= 0) throw new FetchFailed('busy');
    this.free--;
    const job = { cancel: false };
    const work = this.fetchOne(address, job, image).finally(() => { this.free++; });
    work.catch(() => {}); // an abandoned fetch must not end the process
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { job.cancel = true; reject(new FetchFailed('timeout')); }, this.totalTimeout * 1000); });
    try {
      return await Promise.race([work, timeout]);
    } catch (e) {
      if (e instanceof FetchFailed) throw e;
      throw new FetchFailed('network');
    } finally {
      clearTimeout(timer!);
    }
  }

  private async fetchOne(address: string, job: { cancel: boolean }, image: boolean): Promise<Page> {
    const deadline = this.clock() + this.totalTimeout;
    let current = address;
    for (let station = 0; station <= MAX_REDIRECTS; station++) {
      let ip: string;
      try {
        let host: string, port: number;
        [current, host, port] = checkAddress(current);
        if (isBlocked(host, this.blocked())) throw new TargetNotAllowed();
        ip = await pickAddress(this.ctx, host, port); // throws TargetNotAllowed unless every address is public
      } catch {
        throw new FetchFailed('target');
      }
      const remaining = deadline - this.clock();
      if (remaining <= 0 || job.cancel) throw new FetchFailed('timeout');
      const headers = {
        'User-Agent': this.userAgent, 'Accept-Encoding': 'gzip, deflate',
        Accept: image ? 'image/webp,image/jpeg,image/png;q=0.9' : 'text/html,application/xhtml+xml;q=0.9',
      };
      let res;
      try {
        res = await outgoing(this.ctx).fetch('web', {
          method: 'GET', url: current, headers, address: ip, timeout: remaining, connectTimeout: Math.min(remaining, 4.0),
          maxBytes: image ? MAX_IMAGE_BYTES : MAX_BYTES,
        });
      } catch (e) {
        throw new FetchFailed(e instanceof OutError && e.kind === 'too_large' ? 'too_large' : 'network');
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.location ?? '';
        let next = '';
        try { next = location ? new URL(location, current).href : ''; } catch { next = ''; }
        if (!next || station === MAX_REDIRECTS) throw new FetchFailed('redirect');
        if (current.startsWith('https://') && next.toLowerCase().startsWith('http://')) throw new FetchFailed('downgrade');
        current = next;
        continue;
      }
      if (res.status !== 200) throw new FetchFailed('status');
      const contentType = res.headers['content-type'] ?? '';
      const kind = contentType.split(';')[0]!.trim().toLowerCase();
      if (image) {
        if (!IMAGE_TYPES.includes(kind)) throw new FetchFailed('not_image');
        return { url: current, text: '', data: await readBody(res.headers, res.body, MAX_IMAGE_BYTES) };
      }
      if (!CONTENT_TYPES.includes(kind)) throw new FetchFailed('not_html');
      return { url: current, text: decode(await readBody(res.headers, res.body, MAX_BYTES), contentType), data: new Uint8Array() };
    }
    throw new FetchFailed('redirect');
  }
}

// ---- reading the page ----

/** The text of `<script type="application/ld+json">` blocks; everything else is ignored. Comments are skipped, so a block that is
 * commented out is not read. The page is scanned once with `indexOf` and quantifier-free patterns: a page is untrusted, and a pattern
 * like `<script\b([^>]*)>` is quadratic on many `<script` without `>` (seconds of a blocked process for a few hundred KB). At most
 * MAX_TAGS tags (scripts and comments) are looked at. */
function ldScripts(page: string): string[] {
  const blocks: string[] = [];
  const open = /<!--|<script\b/gi;
  const close = /<\/script\b/gi;
  let tags = 0;
  let m: RegExpExecArray | null;
  while (blocks.length < MAX_BLOCKS && tags++ < MAX_TAGS && (m = open.exec(page)) !== null) {
    if (m[0] === '<!--') {
      const end = page.indexOf('-->', m.index + 4);
      if (end === -1) break; // an open comment runs to the end of the page
      open.lastIndex = end + 3;
      continue;
    }
    const gt = page.indexOf('>', m.index + m[0].length);
    if (gt === -1) break; // no tag can end any more
    const type = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(page.slice(m.index + m[0].length, gt));
    const kind = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').split(';')[0]!.trim().toLowerCase();
    const start = gt + 1;
    close.lastIndex = start;
    const c = close.exec(page);
    const end = c === null ? page.length : c.index;
    open.lastIndex = end;
    if (kind === 'application/ld+json' && end - start <= MAX_BLOCK_BYTES) blocks.push(page.slice(start, end));
  }
  return blocks;
}

/** `value` as a finite float of sane size, else null (NaN, infinity, huge integers, text that is no number). */
export function finite(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'boolean') n = Number(value);
  else if (typeof value === 'string') {
    const s = value.trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) && !/^[+-]?(inf|infinity|nan)$/i.test(s)) return null;
    n = Number(s);
  } else return null;
  return Number.isFinite(n) && Math.abs(n) <= 1e12 ? n : null;
}

/** The parsed JSON-LD values of the page (broken blocks are skipped). */
export function jsonLdBlocks(page: string): unknown[] {
  if (!page.slice(0, MAX_BYTES * 2).toLowerCase().includes('ld+json')) return [];
  const values: unknown[] = [];
  for (const raw of ldScripts(page)) {
    let text = raw.trim();
    text = text.replace(/^(?:<!--|\/\/\s*<!\[CDATA\[|\/\*\s*<!\[CDATA\[\s*\*\/)/, '').trim();
    text = text.replace(/(?:-->|\/\/\s*\]\]>|\/\*\s*\]\]>\s*\*\/)$/, '').trim();
    if (!text) continue;
    try { values.push(JSON.parse(text)); } catch { continue; }
  }
  return values;
}

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function isRecipe(node: Obj): boolean {
  const kind = node['@type'];
  return (Array.isArray(kind) ? kind : [kind]).some((k) => typeof k === 'string' && k.split(/[/:#]/).at(-1)!.toLowerCase() === 'recipe');
}

/** Every `Recipe` object in the JSON-LD values: at the top, in `@graph`, in lists and in the usual wrappers, searched breadth first
 * with a bound on depth and on the number of objects. */
export function findRecipes(values: unknown[]): Obj[] {
  const found: Obj[] = [];
  const queue: [unknown, number][] = values.map((v) => [v, 0]);
  let seen = 0;
  // a read index instead of queue.shift() (which copies a long queue: quadratic on a page of big lists); every value taken counts
  for (let next = 0; next < queue.length && next < MAX_QUEUE && seen < MAX_NODES; next++) {
    const [node, depth] = queue[next]!;
    if (Array.isArray(node)) {
      if (depth < MAX_DEPTH && queue.length < MAX_QUEUE) queue.push(...node.slice(0, 500).map((n): [unknown, number] => [n, depth + 1]));
      continue;
    }
    if (!isObj(node)) continue;
    seen++;
    if (isRecipe(node)) found.push(node);
    if (depth < MAX_DEPTH) {
      for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item', 'hasPart']) {
        if (key in node && typeof node[key] === 'object' && node[key] !== null) queue.push([node[key], depth + 1]);
      }
    }
  }
  return found;
}

/** Plain text from whatever the page gave: tags and entities resolved, control characters gone, blanks collapsed, cut off. */
export function cleanText(input: unknown, limit = MAX_LINE): string {
  let value = input;
  if (Array.isArray(value)) value = value.find((v) => typeof v === 'string' && v.trim()) ?? '';
  if (isObj(value)) value = value.name || value['@value'] || '';
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return '';
  let text = unescapeHtml(cut(value, limit * 8).replace(/<[^>]{0,300}>/g, ' '));
  text = chars(text).filter((c) => !CONTROL.test(c) || '\n\t '.includes(c)).join('');
  return cut(text.split(/\s+/).filter(Boolean).join(' '), limit);
}

const NUMBER = /^-?\d[\d.,  ' ]*/;
const NUMBER_ANY = /-?\d[\d.,  ' ]*/;

/** The first number in a text: `12,5`, `12.5`, `1.200`, `1,200`, `1 200`, `1.234,5`, `1,234.5`. A single separator followed by exactly
 * three digits is a thousands separator only when `thousandsOk` (milligrams, kcal, kJ), else a decimal sign. */
export function parseNumber(text: string, thousandsOk = false): number | null {
  const match = NUMBER.exec(text.trim().replace(/−/g, '-')) ?? NUMBER_ANY.exec(text);
  if (!match) return null;
  let raw = match[0].replace(/[.,' ]+$/, '').replace(/[  ' ]/g, '');
  if (!raw || raw === '-') return null;
  const dots = raw.split('.').length - 1, commas = raw.split(',').length - 1;
  if (dots && commas) {
    const decimal = raw.lastIndexOf('.') > raw.lastIndexOf(',') ? '.' : ',';
    raw = raw.replaceAll(decimal === '.' ? ',' : '.', '').replace(decimal, '.');
  } else if (dots + commas > 1) raw = raw.replaceAll('.', '').replaceAll(',', ''); // 1.234.567 or 1,234,567
  else if (dots + commas === 1) {
    const sign = dots ? '.' : ',';
    const [head, tail] = raw.split(sign) as [string, string];
    const h = head.replace(/^-/, '');
    const thousands = thousandsOk && tail.length === 3 && isDigits(h) && h.length >= 1 && h.length <= 3 && !h.startsWith('0');
    raw = thousands ? head + tail : head + '.' + tail;
  }
  return finite(raw);
}

const UNIT = /(?<![A-Za-z])(kcal|kj|cal|mg|g|gr|gramm|gram|grams|mcg|µg|μg|ug)\b/i;

/** [number, unit in lower case or ''] of a nutrition value given as number or text such as `523 kcal` or `12,5 g`. `bareThousands`:
 * a number without unit may use `1.200` for 1200 (energy and sodium, which are whole numbers). */
function withUnit(value: unknown, bareThousands = false): [number | null, string] {
  if (typeof value === 'boolean') return [null, ''];
  if (typeof value === 'number') return [finite(value), ''];
  if (isObj(value)) { // a QuantitativeValue
    const [number, unit] = withUnit(value.value, bareThousands);
    return [number, unit || cleanText(value.unitText || value.unitCode || '', 12).toLowerCase()];
  }
  if (Array.isArray(value)) return withUnit(value.find((v) => v !== null && v !== '') ?? null, bareThousands);
  if (typeof value !== 'string') return [null, ''];
  const text = cut(unescapeHtml(value), 200);
  const unit = UNIT.exec(text);
  const name = unit ? unit[1]!.toLowerCase() : '';
  return [parseNumber(text, ['mg', 'kcal', 'kj', 'cal'].includes(name) || (name === '' && bareThousands)), name];
}

/** kcal from `523 kcal`, `523`, `2190 kJ`, `523 kcal / 2190 kJ` (kcal wins when both are there), else null. */
export function parseEnergy(value: unknown): number | null {
  if (typeof value === 'string') {
    const text = cut(unescapeHtml(value), 200);
    const kcal = /(-?\d[\d.,\s]*)\s*(?:kcal|calories|cal\b)/i.exec(text);
    if (kcal) {
      const n = parseNumber(kcal[1]!, true);
      return n !== null && n >= 0 ? n : null;
    }
    const kj = /(-?\d[\d.,\s]*)\s*kj\b/i.exec(text);
    if (kj) {
      const n = parseNumber(kj[1]!, true);
      return n === null || n < 0 ? null : n / KJ_PER_KCAL;
    }
  }
  const [n, unit] = withUnit(value, true);
  if (n === null || n < 0) return null;
  return unit === 'kj' ? n / KJ_PER_KCAL : n;
}

const GRAMS: Record<string, number> = { '': 1, g: 1, gr: 1, gramm: 1, gram: 1, grams: 1, mg: 0.001, mcg: 1e-6, 'µg': 1e-6, 'μg': 1e-6, ug: 1e-6 };

export function parseGrams(value: unknown, defaultUnit = 'g'): number | null {
  const [n, unit0] = withUnit(value, defaultUnit === 'mg');
  if (n === null || n < 0) return null;
  const factor = GRAMS[unit0 || defaultUnit];
  return factor === undefined ? null : n * factor;
}

/** [portions, was_a_range] from `recipeYield`: 4, "4", "4 portions", "Serves 4", "4-6 servings", ["8", "8 servings"], a
 * QuantitativeValue. null when there is no usable number (0 and more than MAX_PORTIONS count as none). */
export function parseYield(value: unknown): [number | null, boolean] {
  if (isObj(value)) value = value.value ?? value.name;
  const candidates = Array.isArray(value) ? value : [value];
  for (const item of candidates.slice(0, 6)) {
    if (typeof item === 'boolean' || item === null || item === undefined) continue;
    let number: number | null, ranged = false;
    if (typeof item === 'number') number = finite(item);
    else if (isObj(item)) [number, ranged] = parseYield(item);
    else if (typeof item === 'string') {
      const text = cut(unescapeHtml(item), 120);
      ranged = /\d\s*(?:-|–|to|bis)\s*\d/.test(text);
      number = parseNumber(text);
    } else continue;
    if (number !== null && number > 0 && number <= MAX_PORTIONS) return [roundHalfEven(number, 2), ranged];
  }
  return [null, false];
}

const GRAM_FIELDS: Record<string, string> = {
  protein: 'proteinContent', carbs: 'carbohydrateContent', fat: 'fatContent', saturated_fat: 'saturatedFatContent',
  sugars: 'sugarContent', fiber: 'fiberContent',
};

/** What a page said, before it is interpreted: the nutrition values AS WRITTEN (per serving unless the person says otherwise). */
export interface Parsed {
  name: string;
  portions: number | null;
  portions_range: boolean;
  values: Record<string, number | null>; // kcal, protein, carbs, fat, saturated_fat, sugars, fiber (g), salt (g), sodium (mg)
  serving_size: string;
  ingredients: string[];
  image: string | null; // the address of the picture the page names, as written (maybe relative)
}

/** The first address in an `image` value: a text, a list of them, an `ImageObject` (`url`, `contentUrl`, `@id`). */
function imageText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value.trim();
  if (depth < 3 && Array.isArray(value)) {
    for (const item of value.slice(0, 6)) { const f = imageText(item, depth + 1); if (f) return f; }
  }
  if (depth < 3 && isObj(value)) {
    for (const key of ['url', 'contentUrl', '@id']) { const f = imageText(value[key], depth + 1); if (f) return f; }
  }
  return '';
}

/** The absolute, checked address of the picture (a relative or protocol-relative one is resolved against the page), else null. */
export function imageAddress(raw: string | null, pageUrl: string): string | null {
  if (!raw || chars(raw).length > MAX_URL) return null;
  let address: string;
  try { address = checkAddress(new URL(raw.trim(), pageUrl).href)[0]; } catch { return null; }
  if (pageUrl.toLowerCase().startsWith('https://') && address.startsWith('http://')) return null; // plain http from an https page: it could be swapped on the way
  return address;
}

export function parseRecipe(node: Obj): Parsed {
  let nutrition = node.nutrition;
  if (Array.isArray(nutrition)) nutrition = nutrition.find((n) => isObj(n));
  const nut: Obj = isObj(nutrition) ? nutrition : {};
  const values: Record<string, number | null> = { kcal: 'calories' in nut ? parseEnergy(nut.calories) : null };
  for (const [key, name] of Object.entries(GRAM_FIELDS)) values[key] = name in nut ? parseGrams(nut[name]) : null;
  const sodium = 'sodiumContent' in nut ? parseGrams(nut.sodiumContent, 'mg') : null; // grams here
  values.sodium = sodium === null ? null : sodium * 1000.0;
  const salt = 'saltContent' in nut ? parseGrams(nut.saltContent) : null;
  values.salt = salt !== null ? salt : sodium !== null ? sodium * SALT_PER_SODIUM : null;
  const [portions, ranged] = parseYield('recipeYield' in node ? node.recipeYield : node.yield);
  const rawLines = 'recipeIngredient' in node ? node.recipeIngredient : node.ingredients;
  const lines: unknown[] = Array.isArray(rawLines) ? rawLines : typeof rawLines === 'string' ? [rawLines] : [];
  return {
    name: cleanText(node.name, MAX_NAME), portions, portions_range: ranged, values, serving_size: cleanText(nut.servingSize, 60),
    ingredients: lines.slice(0, MAX_INGREDIENTS).map((i) => cleanText(i, MAX_LINE)).filter(Boolean),
    image: imageText('image' in node ? node.image : node.thumbnailUrl) || null,
  };
}

/** The recipe of a page: the first one that has nutrition values, else the first one. null without any `Recipe`. */
export function parsePage(page: string): Parsed | null {
  const recipes = findRecipes(jsonLdBlocks(page));
  if (!recipes.length) return null;
  const parsed = recipes.slice(0, 20).map(parseRecipe);
  return parsed.find((p) => p.values.kcal !== null) ?? parsed[0]!;
}

// ---- interpreting ----

export interface Interpreted {
  name: string;
  portions: number | null;
  per_portion: Record<string, number | null>; // kcal, fat, saturated_fat, carbs, sugars, fiber, protein, salt (null = unknown)
  extra: Record<string, number>; // sodium in mg per portion
  complete: boolean;
  warnings: string[];
  blocked: string | null; // why it cannot be taken over as it is
}

function energyEstimate(v: Record<string, number | null>): number | null {
  if (v.protein == null || v.carbs == null || v.fat == null) return null;
  return 4 * v.protein + 4 * v.carbs + 9 * v.fat;
}

/** Values per portion from what the page said. `whole`: the page gave the values for the whole recipe, so they are divided by the
 * portions. `portions` and `name` are the corrections of the person. Warning codes: no_portions, portions_range, energy_mismatch,
 * maybe_whole, maybe_per_100, rounded_off. Blocked: no_name, no_energy, too_high, whole_needs_portions. */
export function interpret(parsed: Parsed, opts: { whole?: boolean; portions?: number | null; name?: string | null } = {}): Interpreted {
  const whole = opts.whole ?? false;
  const warnings: string[] = [];
  const portions = opts.portions ?? null;
  const count = portions !== null && portions > 0 && portions <= MAX_PORTIONS ? portions : parsed.portions;
  if (portions === null) {
    if (parsed.portions === null) warnings.push('no_portions');
    else if (parsed.portions_range) warnings.push('portions_range');
  }
  const chosenName = opts.name != null ? cleanText(opts.name, MAX_NAME) : parsed.name;
  const values = Object.fromEntries(Object.entries(parsed.values).map(([k, v]) => [k, finite(v)]));
  let blocked: string | null = null;
  let divisor = 1.0;
  if (whole) {
    if (count === null) blocked = 'whole_needs_portions';
    else divisor = count;
  }
  const raw = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === null ? null : v / divisor]));
  const kcal = raw.kcal ?? null;
  const per: Record<string, number | null> = Object.fromEntries(['kcal', 'fat', 'saturated_fat', 'carbs', 'sugars', 'fiber', 'protein', 'salt'].map((k) => [k, raw[k] ?? null]));
  for (const key of ['fat', 'saturated_fat', 'carbs', 'sugars', 'fiber', 'protein', 'salt']) {
    if (per[key] != null && per[key]! > MAX_GRAMS) {
      per[key] = null; // not plausible for one portion: unknown, not a wrong number
      warnings.push('rounded_off');
    }
  }
  const extra: Record<string, number> = raw.sodium == null || raw.sodium > 40000 ? {} : { sodium: roundHalfEven(raw.sodium, 1) };
  for (const k of Object.keys(per)) per[k] = per[k] === null ? null : roundHalfEven(per[k]!, 2);
  per.kcal = kcal === null ? null : roundHalfEven(kcal, 1);
  if (!chosenName) blocked = blocked ?? 'no_name';
  if (kcal === null) blocked = blocked ?? 'no_energy';
  else if (kcal > MAX_KCAL) blocked = blocked ?? 'too_high';
  if (kcal !== null && blocked !== 'too_high') {
    const estimate = energyEstimate(per);
    if (estimate !== null && Math.abs(kcal - estimate) > Math.max(80.0, 0.35 * estimate)) warnings.push('energy_mismatch');
    if (!whole && (((count ?? 1) > 1 && kcal > 1500) || ['carbs', 'fat', 'protein'].some((k) => (per[k] ?? 0) > 150))) warnings.push('maybe_whole');
    if (/\b100\s*(?:g|ml)\b/i.test(parsed.serving_size) && (count ?? 1) > 1) warnings.push('maybe_per_100');
  }
  const complete = ['kcal', 'fat', 'carbs', 'protein'].every((k) => per[k] != null);
  return { name: chosenName, portions: count, per_portion: per, extra, complete, warnings: [...new Set(warnings)], blocked };
}

/** The food that stands for the recipe: the values of ONE portion, stored as 100 g (so 100 g = 1 portion in the diary). The brand
 * carries the host after BRAND_PREFIX (the host of the page that answered, `hostFrom`). No steps, pictures, descriptions or ingredient lines. */
export function foodData(item: Interpreted, address: string, hostFrom: string | null = null) {
  return {
    name: cut(item.name, MAX_NAME), brand: BRAND_PREFIX + hostLabel(hostFrom || address), quantity: null, serving_size: '1 portion',
    serving_quantity: REFERENCE_AMOUNT, unit: 'g' as const, per_100: item.per_portion, extra: item.extra, complete: item.complete,
    portions: item.portions, url: address,
  };
}

// ---- remembering what was fetched for a few minutes ----

/** What a page gave, for a few minutes: the preview, the switch "whole recipe" and the take-over of the same address need one fetch,
 * not three. Shared by everybody (it is a public page), small and bounded. */
export class Cache {
  clock: () => number;
  private ttl: number;
  private size: number;
  items = new Map<string, [number, Parsed | null, string]>();

  constructor(clock: () => number = () => Date.now() / 1000, ttl = 300.0, size = 64) { this.clock = clock; this.ttl = ttl; this.size = size; }

  get(key: string): [Parsed | null, string] | null {
    const hit = this.items.get(key);
    if (hit && hit[0] > this.clock()) return [hit[1], hit[2]];
    this.items.delete(key);
    return null;
  }

  put(key: string, parsed: Parsed | null, address: string): void {
    if (this.items.size >= this.size) {
      let oldest: string | undefined;
      for (const [k, v] of this.items) if (oldest === undefined || v[0] < this.items.get(oldest)![0]) oldest = k;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    this.items.set(key, [this.clock() + this.ttl, parsed, address]);
  }

  drop(key: string): void { this.items.delete(key); }
}
