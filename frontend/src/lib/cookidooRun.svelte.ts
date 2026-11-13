// The run that takes over many Cookidoo recipes (see docs/api-v1.md): one state for the whole page, polled while it runs, so that the
// dialog, the banner on the Recipes page and the list agree. The server keeps the run (and its end for an hour); this only looks.
import { api } from './api';
import { t } from './i18n';
import type { CookidooBulkRun } from './types';

export const cookRun = $state<{ run: CookidooBulkRun | null }>({ run: null });
/** The run whose result was hidden with "Hide" (by its start time). */
export const runUi = $state<{ hidden: number }>({ hidden: 0 });
const finished = new Set<(run: CookidooBulkRun) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let announced = '';

/** Called once when a run that was running ends (done, stopped or failed): the list reloads. */
export function onRunFinished(fn: (run: CookidooBulkRun) => void): () => void {
  finished.add(fn);
  return () => finished.delete(fn);
}

export async function refreshRun(): Promise<CookidooBulkRun | null> {
  const before = cookRun.run;
  try { cookRun.run = await api.cookidooImport(); } catch { return cookRun.run; }
  const now = cookRun.run;
  if (now && before?.state === 'running' && now.state !== 'running' && before.started_at === now.started_at) finished.forEach((fn) => fn(now));
  if (now?.state === 'running') schedule();
  return now;
}

function schedule() {
  if (timer) return;
  timer = setTimeout(async () => { timer = null; await refreshRun(); }, 2000);
}

export function setRun(run: CookidooBulkRun | null) {
  cookRun.run = run;
  if (run?.state === 'running') schedule();
}

/** The spoken line for a screen reader: only the start and the end are announced, not every recipe. */
export function announcement(run: CookidooBulkRun | null): string {
  if (!run) return '';
  const key = `${run.started_at}:${run.state}`;
  if (key === announced) return '';
  announced = key;
  return run.state === 'running' ? t('cbAnnounceStart', { n: String(run.total) }) : t('cbAnnounceDone');
}

/** "about 6 min" style, always rounded up to whole minutes beyond one minute. */
export function duration(seconds: number): string {
  if (seconds < 60) return seconds <= 5 ? t('cbDurLess') : t('cbDurS', { n: String(Math.round(seconds / 5) * 5) });
  return t('cbDurM', { n: String(Math.ceil(seconds / 60)) });
}
