<script lang="ts">
  // Import from Yazio, two ways into the same preview: upload the files of the Yazio export (or a ZIP), or, when an admin switched
  // it on, sign in at Yazio once. Nothing is written before the person confirms the preview; an import is a batch that can be
  // taken back in the "Imported data" card.
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { exportName, packFile } from '../lib/gzip';
  import { fmt, t } from '../lib/i18n';
  import type { YazioPreview, YazioRun, YazioState } from '../lib/types';
  import PasswordField from './PasswordField.svelte';

  let { onimported }: { onimported: () => void } = $props();

  const LIMIT_MB = 24;
  const MONTHS = [3, 6, 12, 24];

  let ystate = $state<YazioState | null>(null);
  let preview = $state<YazioPreview | null>(null);
  let done = $state<YazioPreview | null>(null);
  let step = $state<'idle' | 'uploading' | 'previewing' | 'importing'>('idle');
  let uploadName = $state('');
  let allProducts = $state(false);
  let error = $state('');
  let email = $state('');
  let password = $state('');
  let months = $state(12);
  let formBad = $state(false);
  let starting = $state(false);
  let poll = 0;
  let fileInput: HTMLInputElement | undefined = $state();

  const reason = (err: unknown) => (err instanceof ApiError ? (typeof err.detail === 'string' ? err.detail : String(err.status || err.message)) : 'error');
  const run = $derived<YazioRun | null>(ystate?.login.run ?? null);
  const running = $derived(run?.state === 'running');
  const busy = $derived(step !== 'idle' || running || starting);
  const pct = $derived(run && run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0);

  async function refresh() {
    try { ystate = await api.yazioState(); } catch { /* the card stays as it is */ }
  }

  async function showPreview() {
    step = 'previewing';
    error = '';
    try {
      preview = await api.yazioPreview(allProducts);
    } catch (err) {
      preview = null;
      error = err instanceof ApiError && err.status === 410 ? t('yzExpired') : t('yzFailed', { reason: reason(err) });
    } finally {
      step = 'idle';
    }
  }

  onMount(() => {
    void (async () => {
      await refresh();
      if (ystate?.stage) void showPreview();
      if (ystate?.login.run?.state === 'running') watch();
    })();
    return () => clearInterval(poll);
  });

  async function choose(files: FileList | null) {
    if (!files || files.length === 0) return;
    error = '';
    done = null;
    const chosen = [...files].map((file) => ({ file, name: exportName(file.name) }));
    const bad = chosen.find((c) => !c.name);
    if (bad) { error = t('yzBadFile', { name: bad.file.name }); if (fileInput) fileInput.value = ''; return; }
    step = 'uploading';
    preview = null;
    try {
      // a ZIP replaces everything on the server, so it goes first; the single files are collected
      for (const c of chosen.sort((a, b) => Number(b.name === 'export.zip') - Number(a.name === 'export.zip'))) {
        uploadName = c.file.name;
        const body = c.name === 'export.zip' ? c.file : await packFile(c.file);
        if (body.size > LIMIT_MB * 1024 * 1024) { error = t('yzTooBig', { mb: LIMIT_MB }); return; }
        await api.yazioUpload(c.name!, body);
      }
    } catch (err) {
      error = err instanceof ApiError && err.status === 413 ? t('yzTooBig', { mb: LIMIT_MB }) : t('yzFailed', { reason: reason(err) });
      return;
    } finally {
      step = 'idle';
      if (fileInput) fileInput.value = '';
    }
    await showPreview();
  }

  async function confirm() {
    if (!preview || busy) return;
    step = 'importing';
    error = '';
    try {
      done = await api.yazioConfirm(preview.token, allProducts);
      preview = null;
      await refresh();
      onimported();
    } catch (err) {
      error = err instanceof ApiError && (err.status === 410 || err.status === 409) ? t('yzExpired') : t('yzFailed', { reason: reason(err) });
      if (err instanceof ApiError && err.status === 410) preview = null;
    } finally {
      step = 'idle';
    }
  }

  async function discard() {
    clearInterval(poll);
    try { await api.yazioDiscard(); } catch { /* it expires by itself */ }
    preview = null;
    error = '';
    await refresh();
  }

  async function toggleAll() {
    allProducts = !allProducts;
    if (preview) await showPreview();
  }

  // ---- direct sign-in ----
  function watch() {
    clearInterval(poll);
    poll = window.setInterval(async () => {
      await refresh();
      const r = ystate?.login.run;
      if (r && r.state !== 'running') {
        clearInterval(poll);
        if (r.state === 'done') await showPreview();
      }
    }, 1500);
  }

  async function login(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) { formBad = true; return; }
    formBad = false;
    error = '';
    done = null;
    preview = null;
    starting = true;
    const sent = { email: email.trim(), password, months };
    password = ''; // gone from this page at once; the server uses it for one request
    try {
      await api.yazioLogin(sent);
      email = '';
      await refresh();
      watch();
    } catch (err) {
      error = t('yzFailed', { reason: reason(err) });
    } finally {
      starting = false;
    }
  }
  const runError = $derived(run?.state === 'error' ? t('yzRunFailed', { reason: run.error ?? '' }) : run?.state === 'cancelled' ? t('yzRunCancelled') : '');
</script>

<section class="icard yz" aria-labelledby="yz-title">
  <h2 id="yz-title" class="micro quiet">{t('yzTitle')}</h2>
  <p class="note">{t('yzText')}</p>

  <div class="pick">
    <input bind:this={fileInput} id="yz-files" class="sr-only" type="file" multiple accept=".json,.zip,application/json,application/zip" disabled={busy}
      onchange={(e) => choose(e.currentTarget.files)} />
    <label for="yz-files" class="btn primary" class:off={busy}>{preview ? t('yzChooseAgain') : t('yzChoose')}</label>
    <span class="mono small quiet">days.json · products.json · weight.json · .zip</span>
  </div>
  <div role="status" aria-live="polite">
    {#if step === 'uploading'}<p class="note">{t('yzUploading', { name: uploadName })}</p>{/if}
    {#if step === 'previewing'}<p class="note">{t('yzPreparing')}</p>{/if}
  </div>

  {#if preview}
    {@const p = preview}
    <div class="pv" aria-labelledby="yz-pv">
      <h3 id="yz-pv" class="micro">{t('yzPreviewTitle')}</h3>
      <dl class="grid">
        <div class="st"><dt>{t('yzDays')}</dt><dd class="display">{fmt(p.days)}</dd></div>
        <div class="st"><dt>{t('yzEntries')}</dt><dd class="display">{fmt(p.entries_total)}</dd></div>
        <div class="st"><dt>{t('yzFoods')}</dt><dd class="display">{fmt(p.foods_created)}</dd>{#if p.foods_reused}<small>{t('yzFoodsReused', { n: fmt(p.foods_reused) })}</small>{/if}</div>
        <div class="st"><dt>{t('yzWeights')}</dt><dd class="display">{fmt(p.weights)}</dd>{#if p.weights_kept}<small>{t('yzKept', { n: fmt(p.weights_kept) })}</small>{/if}</div>
        <div class="st"><dt>{t('yzWater')}</dt><dd class="display">{fmt(p.water)}</dd>{#if p.water_kept}<small>{t('yzKept', { n: fmt(p.water_kept) })}</small>{/if}</div>
        <div class="st"><dt>{t('yzActivity')}</dt><dd class="display">{fmt(p.activity_days)}</dd>{#if p.activity_kept}<small>{t('yzKept', { n: fmt(p.activity_kept) })}</small>{/if}</div>
        <div class="st"><dt>{t('yzWorkouts')}</dt><dd class="display">{fmt(p.workouts)}</dd></div>
      </dl>
      {#if p.entries_total > 0}<p class="note mono">{t('yzEntriesSplit', { p: fmt(p.entries.product), r: fmt(p.entries.recipe), q: fmt(p.entries.quick) })}</p>{/if}
      {#if p.already_imported}<p class="note">{t('yzAlready', { n: fmt(p.already_imported) })}</p>{/if}
      <p class="note">{p.goal_set ? t('yzGoalSet') : t('yzGoalKept')}</p>
      {#if p.missing_files.length}<p class="note">{t('yzMissing', { files: p.missing_files.join(', ') })}</p>{/if}
      {#if p.skipped.length}
        <details>
          <summary>{t('yzSkipped', { n: fmt(p.skipped.reduce((n: number, s: { count: number }) => n + s.count, 0)) })}</summary>
          <ul>{#each p.skipped as s (s.reason)}<li><span class="mono">{fmt(s.count)}×</span> {s.reason}</li>{/each}</ul>
        </details>
      {/if}
      <label class="check"><input type="checkbox" checked={allProducts} disabled={busy} onchange={toggleAll} />{t('yzAllProducts')}</label>
      <p class="note">{t('yzPreviewNote')}</p>
      <div class="acts">
        <button type="button" class="btn primary" onclick={confirm} disabled={busy || (p.entries_total + p.foods_created + p.weights + p.water + p.activity_days + p.workouts === 0)}>
          {step === 'importing' ? t('yzImporting') : t('yzImport')}
        </button>
        <button type="button" class="btn quiet-btn" onclick={discard} disabled={busy}>{t('yzDiscard')}</button>
      </div>
      {#if p.entries_total + p.foods_created + p.weights + p.water + p.activity_days + p.workouts === 0}<p class="note">{t('yzNothing')}</p>{/if}
    </div>
  {/if}

  {#if done}
    <p class="note ok" role="status">{t('yzDone', { entries: fmt(done.entries_total), foods: fmt(done.foods_created), weights: fmt(done.weights) })}</p>
  {/if}
  {#if error}<p class="note warn" role="alert">{error}</p>{/if}

  {#if ystate?.login.available}
    <div class="live" role="group" aria-labelledby="yz-live">
      <h3 id="yz-live" class="micro quiet">{t('yzLoginTitle')}</h3>
      <p class="note warnbox">{t('yzLoginWarn')}</p>
      <form onsubmit={login} novalidate autocomplete="off">
        <div class="field">
          <label for="yz-email">{t('yzEmail')}</label>
          <input id="yz-email" name="yazio-account" type="email" inputmode="email" bind:value={email} autocomplete="off" autocapitalize="off" spellcheck="false"
            maxlength="200" disabled={busy} aria-invalid={formBad && !email.trim() ? 'true' : undefined} />
        </div>
        <PasswordField id="yz-pw" name="yazio-secret" label={t('yzPassword')} bind:value={password} invalid={formBad && !password} />
        <div class="field">
          <span id="yz-months">{t('yzPeriod')}</span>
          <div class="chips" role="group" aria-labelledby="yz-months">
            {#each MONTHS.filter((m) => m <= (ystate?.login.max_months ?? 24)) as m}
              <button type="button" class="chip" class:on={months === m} aria-pressed={months === m} onclick={() => (months = m)}>{t('yzMonthsN', { n: m })}</button>
            {/each}
          </div>
        </div>
        <div class="acts">
          <button type="submit" class="btn" disabled={busy}>{running || starting ? t('yzFetching') : t('yzFetch')}</button>
          {#if running}<button type="button" class="btn quiet-btn" onclick={discard}>{t('yzCancel')}</button>{/if}
        </div>
      </form>
      {#if running && run}
        <div class="prog" role="status" aria-live="polite">
          <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct} aria-label={t(`yzPhase_${run.phase}` as 'yzPhase_days')}><i style="width:{Math.max(pct, 4)}%"></i></div>
          <p class="note">{t(`yzPhase_${run.phase}` as 'yzPhase_days')}{#if run.total > 0} · {t('yzProgress', { done: fmt(run.done), total: fmt(run.total) })}{/if}</p>
        </div>
      {/if}
      {#if runError}<p class="note warn" role="alert">{runError}</p>{/if}
    </div>
  {/if}
</section>

<style>
  .yz { gap: 14px; }
  .pick { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
  .pick label.btn { cursor: pointer; }
  .pick label.btn.off { opacity: 0.55; pointer-events: none; }
  input[type='file']:focus-visible + label { outline: 3px solid var(--focus); outline-offset: 2px; }
  .small { font-size: 11.5px; }
  .pv { background: var(--stone); border-radius: 24px 24px 24px 8px; padding: 16px 16px 14px 18px; display: flex; flex-direction: column; gap: 10px; }
  .pv h3 { color: var(--green-text); }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0; }
  .st { background: var(--paper); border-radius: 18px 18px 18px 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .st dt { font-family: var(--f-mono); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--quiet); }
  .st dd { margin: 0; font-size: 28px; line-height: 1.1; }
  .st small { font-size: 11.5px; color: var(--quiet); }
  details { font-size: 13px; color: var(--quiet); }
  summary { cursor: pointer; min-height: 32px; display: flex; align-items: center; }
  details ul { margin: 4px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }
  .check { background: var(--paper); }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .note.ok { color: var(--green-text); font-weight: 600; }
  .live { border-top: 1px solid var(--hairline); padding-top: 14px; display: flex; flex-direction: column; gap: 10px; }
  .warnbox { background: var(--stone); border-radius: 16px 16px 16px 6px; padding: 10px 14px; color: var(--text); border-left: 4px solid var(--warn); }
  form { display: flex; flex-direction: column; gap: 12px; }
  .field input[type='email'] { background: var(--stone); }
  label { font-size: 13px; font-weight: 600; }
  .field > label { color: var(--quiet); }
  .check { font-size: 14px; font-weight: 500; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { border-radius: 22px 22px 22px 8px; }
  .prog { display: flex; flex-direction: column; gap: 6px; }
  .bar { height: 10px; border-radius: 5px; background: var(--track); overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 5px; background: var(--bar); transition: width 300ms; }
  @media (min-width: 560px) { .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
</style>
