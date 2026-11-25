// Background work inside the service: the catalogue refresh started from the admin area (one at a time) (jobs.py).
//
// Runs the import in a worker thread. The import builds a new file and swaps it in atomically, so searches keep working while it runs
// and a failed import leaves the old catalogue alone. Failures end up in the state. It can be switched off with
// MAHLWERK_CATALOG_REFRESH=off (`enabled` is then false and `start()` starts nothing); MAHLWERK_CATALOG_SOURCE names another source
// (a URL or a local .csv.gz file) than the official export.
import { Worker } from 'node:worker_threads';
import { countries } from '../core/features.ts';
import type { Ctx } from '../core/http.ts';
import type { Catalog, CatalogRefreshService, RefreshState } from '../core/catalog.ts';
import { OFF_URL } from './catalogImport.ts';

const MAX_ERROR = 300;

export class CatalogRefresh implements CatalogRefreshService {
  ctx: Ctx;
  catalog: Catalog;
  source: string;
  enabled: boolean;
  private current: RefreshState = { state: 'idle', started_at: null, finished_at: null, progress: null, countries: [], result: null, error: null };
  private worker: Worker | null = null;
  private waiting: (() => void)[] = [];

  constructor(ctx: Ctx, catalog: Catalog) {
    this.ctx = ctx;
    this.catalog = catalog;
    this.source = ctx.env.MAHLWERK_CATALOG_SOURCE || OFF_URL;
    this.enabled = !['off', '0', 'no', 'false'].includes((ctx.env.MAHLWERK_CATALOG_REFRESH ?? '').trim().toLowerCase());
  }

  status(): RefreshState { return { ...this.current }; }

  /** Start a refresh; false when one is already running (or the refresh is switched off). */
  async start(): Promise<boolean> {
    if (!this.enabled || this.current.state === 'running') return false;
    const list = await countries(this.ctx);
    this.current = { state: 'running', started_at: Math.floor(Date.now() / 1000), finished_at: null, progress: null, countries: [...list], result: null, error: null };
    const worker = new Worker(new URL('./catalogImportWorker.ts', import.meta.url), { workerData: { dest: this.catalog.path, countries: list, source: this.source } });
    this.worker = worker;
    const finish = (update: Partial<RefreshState>) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.current = { ...this.current, ...update, finished_at: Math.floor(Date.now() / 1000) };
      for (const f of this.waiting.splice(0)) f();
    };
    worker.on('message', (m: any) => {
      if ('progress' in m) this.current.progress = m.progress;
      else if ('done' in m) finish({ state: 'done', error: null, result: { rows_read: m.done.read, products: m.done.kept, seconds: Math.round(m.done.seconds * 10) / 10, truncated: m.done.truncated } });
      else if ('error' in m) { console.warn('catalogue refresh failed'); finish({ state: 'error', error: String(m.error).slice(0, MAX_ERROR) }); }
    });
    worker.on('error', (e) => { console.warn('catalogue refresh failed:', e.name); finish({ state: 'error', error: (e.message || e.name).slice(0, MAX_ERROR) }); });
    worker.on('exit', () => finish({ state: 'error', error: 'the import ended without a result' }));
    return true;
  }

  wait(timeoutSeconds = 30): Promise<void> {
    if (this.current.state !== 'running') return Promise.resolve();
    return new Promise((resolve) => { const t = setTimeout(resolve, timeoutSeconds * 1000); this.waiting.push(() => { clearTimeout(t); resolve(); }); });
  }
}
