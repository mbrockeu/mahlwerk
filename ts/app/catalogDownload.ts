// The catalogue refresh of the app (server: server/jobs.ts CatalogRefresh, which rebuilds the file from the Open Food Facts export):
// the app loads the ready-made file that the repository's workflow publishes monthly (.github/workflows/catalog.yml). Core fetches
// the manifest catalog.json over the `http` op (GitHub answers with a redirect to its file host: followed here, to those hosts only),
// checks it and hands url, sha256 and sizes to the native `download` op, which loads, checks, unpacks and swaps the file; its state
// (`downloadStatus`) is shown as the refresh state of the admin area.
import type { Catalog } from '../core/catalog.ts';
import type { Outgoing } from '../core/outgoing.ts';
import { errorText, type Bridge } from './bridge.ts';

export const MANIFEST_URL = 'https://github.com/mbrockeu/mahlwerk/releases/download/catalog/catalog.json';
const FILE_PREFIX = 'https://github.com/mbrockeu/mahlwerk/releases/download/catalog/';
const HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const MAX_BYTES = 400 * 1024 * 1024; // the packed file; today about 40 MB
const MAX_ERROR = 300;

export interface Manifest { url: string; sha256: string; bytes: number; db_bytes: number; products: number }
type State = { state: 'idle' | 'running' | 'done' | 'error'; started_at: number | null; finished_at: number | null; progress: string | null;
  countries: string[]; result: { rows_read: number; products: number; seconds: number; truncated: boolean } | null; error: string | null };

/** The manifest, checked: a file of this release, a sha256, sizes in range. Throws with a short reason. */
export function checkManifest(value: unknown): Manifest {
  const m = (value ?? {}) as Record<string, unknown>;
  const int = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;
  if (m.version !== 1) throw new Error('unknown manifest version');
  if (typeof m.url !== 'string' || !m.url.startsWith(FILE_PREFIX) || !/^[\w.-]+\.db\.gz$/.test(m.url.slice(FILE_PREFIX.length))) throw new Error('unexpected file address');
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) throw new Error('no checksum');
  if (!int(m.bytes, MAX_BYTES) || !int(m.db_bytes, MAX_BYTES * 8)) throw new Error('implausible size');
  return { url: m.url, sha256: m.sha256, bytes: m.bytes as number, db_bytes: m.db_bytes as number, products: int(m.products, 10_000_000) ? m.products as number : 0 };
}

/** GET with redirects followed by hand, https and the GitHub hosts only (at most 4 hops). */
async function getJson(out: Outgoing, url: string): Promise<unknown> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:' || !HOSTS.includes(u.hostname)) throw new Error('the manifest is not on GitHub');
    const r = await out.fetch('catalog', { url: current, timeout: 20, maxBytes: 64 * 1024 });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) { current = new URL(r.headers.location, u).toString(); continue; }
    if (r.status !== 200) throw new Error(`the manifest answered ${r.status}`);
    return JSON.parse(new TextDecoder().decode(r.body));
  }
  throw new Error('too many redirects');
}

const mb = (n: number) => (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0);

export class AppCatalogRefresh {
  private bridge: Bridge;
  private out: Outgoing;
  private catalog: Catalog;
  private manifestUrl: string;
  private now: () => number;
  private started: number | null = null;
  private failure: string | null = null; // a failure before the native download began (manifest)
  private starting = false;

  constructor(o: { bridge: Bridge; out: Outgoing; catalog: Catalog; manifestUrl?: string; now?: () => number }) {
    this.bridge = o.bridge; this.out = o.out; this.catalog = o.catalog;
    this.manifestUrl = o.manifestUrl || MANIFEST_URL;
    this.now = o.now ?? (() => Date.now() / 1000);
  }

  async status(): Promise<State> {
    const base: State = { state: 'idle', started_at: this.started, finished_at: null, progress: null, countries: ['en:germany'], result: null, error: null };
    if (this.starting) return { ...base, state: 'running', progress: null };
    if (this.failure) return { ...base, state: 'error', error: this.failure };
    let s: any;
    try { s = await this.bridge({ op: 'downloadStatus' }); } catch { return base; } // an app without the op: nothing ever ran
    const bytes = Number(s?.bytes ?? 0), total = Number(s?.total ?? 0);
    if (s?.state === 'running') return { ...base, state: 'running', progress: total > 0 ? `${mb(bytes)} / ${mb(total)} MB` : null };
    if (s?.state === 'failed') return { ...base, state: 'error', error: String(s.error ?? 'failed').slice(0, MAX_ERROR) };
    if (s?.state === 'done') {
      const products = (await this.catalog.info()).products;
      const seconds = this.started !== null ? Math.max(0, Math.round((this.now() - this.started) * 10) / 10) : 0;
      return { ...base, state: 'done', result: { rows_read: products, products, seconds, truncated: false } };
    }
    return base;
  }

  /** false when one is already running. A failing manifest is reported in the state, not thrown. */
  async start(): Promise<boolean> {
    if (this.starting || (await this.status()).state === 'running') return false;
    this.starting = true;
    this.failure = null;
    this.started = Math.floor(this.now());
    try {
      const m = checkManifest(await getJson(this.out, this.manifestUrl));
      await this.bridge({ op: 'download', target: 'catalog', url: m.url, sha256: m.sha256, bytes: m.bytes, db_bytes: m.db_bytes });
    } catch (e) {
      this.failure = (errorText(e) || 'failed').slice(0, MAX_ERROR);
    } finally {
      this.starting = false;
    }
    return true;
  }
}
