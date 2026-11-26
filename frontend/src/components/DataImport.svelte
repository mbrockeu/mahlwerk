<script lang="ts">
  // "Import my data": a Mahlwerk export (its ZIP or the JSON in it) comes back in – from the server into the app, the other way round,
  // or onto a new device. The server (or the app host) shows a preview first; nothing is written before the person confirms it.
  // Merge (default) deletes nothing; replace deletes the person's own data first and is offered with a warning and an export before.
  import { api, ApiError } from '../lib/api';
  import { deletedTotal, exportUrl, importRows, importTotals } from '../lib/dataExport';
  import { today } from '../lib/date';
  import { fmt, lang, t } from '../lib/i18n';
  import { localApi, localDownload } from '../lib/local';
  import { toast } from '../lib/store.svelte';
  import type { ImportKind, ImportMode, ImportPreview, ImportResult } from '../lib/types';

  let { onimported, maxBytes }: { onimported: () => void; maxBytes: number } = $props();

  const LIMIT_MB = $derived(Math.floor(maxBytes / 1024 / 1024));
  let preview = $state<ImportPreview | null>(null);
  let done = $state<ImportResult | null>(null);
  let mode = $state<ImportMode>('merge');
  let step = $state<'idle' | 'reading' | 'importing'>('idle');
  let error = $state('');
  let fileInput: HTMLInputElement | undefined = $state();

  const busy = $derived(step !== 'idle');
  const view = $derived(preview ? preview.modes[mode] : null);
  const rows = $derived(view?.counts ? importRows(view.counts) : []);
  const totals = $derived(view?.counts ? importTotals(view.counts) : null);
  const inApp = !!localApi();
  const backupHref = exportUrl('all', '', '', today(), lang);
  const reason = (err: unknown) => (err instanceof ApiError ? (typeof err.detail === 'string' ? err.detail : String(err.status || err.message)) : 'error');
  const kindLabel = (k: string) => t(`imK_${k}` as 'imK_foods');
  const reasonLabel = (r: string) => t(`imR_${r}` as 'imR_unknown');
  const warning = (code: string, n: number) => t(`imW_${code}` as 'imW_old_format', { n: fmt(n) });
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB') : '–');

  async function choose(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    error = '';
    done = null;
    preview = null;
    if (file.size > LIMIT_MB * 1024 * 1024) { error = t('imTooBig', { mb: LIMIT_MB }); if (fileInput) fileInput.value = ''; return; }
    step = 'reading';
    try {
      preview = await api.importPreview(file);
      mode = preview.mode_allowed.includes('merge') ? 'merge' : 'replace';
    } catch (err) {
      error = err instanceof ApiError && err.status === 413 ? t('imTooBig', { mb: LIMIT_MB }) : t('imFailed', { reason: reason(err) });
    } finally {
      step = 'idle';
      if (fileInput) fileInput.value = '';
    }
  }

  async function confirm() {
    if (!preview || busy || !view?.allowed) return;
    step = 'importing';
    error = '';
    try {
      done = await api.importConfirm(preview.token, mode);
      preview = null;
      onimported();
    } catch (err) {
      error = err instanceof ApiError && (err.status === 410 || (err.status === 409 && mode === 'merge')) ? t('imExpired') : t('imFailed', { reason: reason(err) });
      if (err instanceof ApiError && err.status === 410) preview = null;
    } finally {
      step = 'idle';
    }
  }

  async function discard() {
    try { await api.importDiscard(); } catch { /* it expires by itself */ }
    preview = null;
    error = '';
  }

  function backup(event: MouseEvent) {
    if (!inApp || !backupHref) return;
    event.preventDefault();
    localDownload(backupHref).catch((e) => toast(t('loadFailed', { reason: e instanceof Error ? e.message : 'error' })));
  }

  const doneTotals = $derived(done ? importTotals(done.counts) : null);
</script>

<section class="icard im" aria-labelledby="im-title" data-testid="data-import">
  <h3 id="im-title" class="micro quiet">{t('imTitle')}</h3>
  <p class="note">{t('imText')}</p>
  <div class="pick">
    <input bind:this={fileInput} id="im-file" class="sr-only" type="file" accept=".zip,.json,application/zip,application/json" disabled={busy}
      onchange={(e) => choose(e.currentTarget.files)} />
    <label for="im-file" class="btn" class:off={busy}>{preview ? t('imChooseAgain') : t('imChoose')}</label>
    <span class="mono small quiet">mahlwerk-export-….zip</span>
  </div>
  <div role="status" aria-live="polite">
    {#if step === 'reading'}<p class="note">{t('imReading')}</p>{/if}
  </div>

  {#if preview}
    {@const p = preview}
    <div class="pv" aria-labelledby="im-pv" data-testid="import-preview">
      <h4 id="im-pv" class="micro">{t('imPreviewTitle')}</h4>
      <p class="note">{t('imFrom', { name: p.account.display_name ?? p.account.username ?? '?', date: when(p.exported_at) })}</p>
      {#if p.range.from || p.range.to}<p class="note">{t('imRange', { from: p.range.from ?? '…', to: p.range.to ?? '…' })}</p>{/if}
      <div class="chips" role="radiogroup" aria-label={t('imPreviewTitle')}>
        {#each ['merge', 'replace'] as const as m}
          <button type="button" role="radio" class="chip" class:on={mode === m} aria-checked={mode === m} disabled={busy} onclick={() => (mode = m)}>{m === 'merge' ? t('imMerge') : t('imReplace')}</button>
        {/each}
      </div>
      {#if mode === 'merge'}
        <p class="note">{t('imMergeHint')}</p>
      {:else}
        <div class="warnbox" role="note">
          <p>{t('imReplaceWarn')}</p>
          {#if view?.allowed && deletedTotal(view.deleted) > 0}<p>{t('imReplaceDeletes', { n: fmt(deletedTotal(view.deleted)) })}</p>{/if}
          {#if backupHref}<a class="btn quiet-btn" href={backupHref} download onclick={backup}>{t('imExportFirst')}</a>{/if}
        </div>
      {/if}
      {#if view && !view.allowed}
        <p class="note warn" role="alert">{t(`imNotAllowed_${view.reason}` as 'imNotAllowed_ranged')}</p>
      {:else if view && totals}
        <div class="scroll"><table class="counts">
          <thead><tr><th></th><th>{t('imColNew')}</th><th>{t('imColChanged')}</th><th>{t('imColSame')}</th><th>{t('imColSkipped')}</th></tr></thead>
          <tbody>
            {#each rows as r (r.kind)}
              <tr>
                <th scope="row">{kindLabel(r.kind as ImportKind)}</th>
                <td>{fmt(r.count.new)}</td><td>{fmt(r.count.changed)}</td><td>{fmt(r.count.unchanged)}</td>
                <td title={Object.entries(r.count.reasons).map(([k, n]) => `${n}× ${reasonLabel(k)}`).join(', ')}>{fmt(r.count.skipped)}</td>
              </tr>
            {/each}
          </tbody>
        </table></div>
        {#if rows.some((r) => r.count.skipped)}
          <ul class="reasons">
            {#each rows.filter((r) => r.count.skipped) as r (r.kind)}
              {#each Object.entries(r.count.reasons) as [k, n] (k)}<li><span class="mono">{fmt(n)}×</span> {kindLabel(r.kind)}: {reasonLabel(k)}</li>{/each}
            {/each}
          </ul>
        {/if}
        <p class="note"><strong>{t('imFileWins')}</strong></p>
        {#if totals.new + totals.changed === 0 && mode === 'merge'}<p class="note">{t('imNothing')}</p>{/if}
      {/if}
      {#each p.warnings as w (w.code)}<p class="note">{warning(w.code, w.count)}</p>{/each}
      <div class="acts">
        <button type="button" class="btn {mode === 'replace' ? 'danger' : 'primary'}" onclick={confirm}
          disabled={busy || !view?.allowed || (mode === 'merge' && !!totals && totals.new + totals.changed === 0)}>
          {step === 'importing' ? t('imImporting') : mode === 'replace' ? `${t('imReplace')}: ${t('imConfirm')}` : t('imConfirm')}
        </button>
        <button type="button" class="btn quiet-btn" onclick={discard} disabled={busy}>{t('imDiscard')}</button>
      </div>
    </div>
  {/if}

  {#if done && doneTotals}
    <p class="note ok" role="status" data-testid="import-done">
      {t('imDone', { new: fmt(doneTotals.new), changed: fmt(doneTotals.changed) })}
      {#if done.deleted && deletedTotal(done.deleted) > 0} {t('imDoneDeleted', { n: fmt(deletedTotal(done.deleted)) })}{/if}
    </p>
  {/if}
  {#if error}<p class="note warn" role="alert">{error}</p>{/if}
</section>

<style>
  .im { gap: 14px; }
  .pick { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .pick label.btn { cursor: pointer; }
  .pick label.btn.off { opacity: 0.55; pointer-events: none; }
  input[type='file']:focus-visible + label { outline: 3px solid var(--focus); outline-offset: 2px; }
  .small { font-size: 11.5px; }
  .pv { background: var(--stone); border-radius: 24px 24px 24px 8px; padding: 16px 16px 14px 18px; display: flex; flex-direction: column; gap: 10px; }
  .pv h4 { color: var(--green-text); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { border-radius: 22px 22px 22px 8px; }
  .scroll { overflow-x: auto; max-width: 100%; }
  .counts { width: 100%; border-collapse: collapse; font-size: 13.5px; background: var(--paper); border-radius: 16px 16px 16px 6px; overflow: hidden; }
  .counts th, .counts td { padding: 6px 5px; text-align: right; font-variant-numeric: tabular-nums; }
  .counts th[scope='row'], .counts thead th:first-child { text-align: left; font-weight: 500; }
  .counts thead th { font-family: var(--f-mono); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--quiet); font-weight: 400; }
  .counts tbody tr + tr { border-top: 1px solid var(--hairline); }
  .reasons { margin: 0; padding-left: 18px; font-size: 13px; color: var(--quiet); display: flex; flex-direction: column; gap: 2px; }
  .warnbox { background: var(--paper); border-radius: 16px 16px 16px 6px; padding: 10px 14px; border-left: 4px solid var(--warn); display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .warnbox p { margin: 0; font-size: 14px; }
  .warnbox a { text-decoration: none; }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .note.ok { color: var(--green-text); font-weight: 600; }
</style>
