<script lang="ts">
  // The run that takes over many Cookidoo recipes: progress while it goes (bar, "12 of 24", the recipe it is on, what has happened so
  // far, "Stop") and, when it ended, the result with the recipes that were not taken over. The server keeps the run, so this is also what
  // a reopened dialog shows. Only the start and the end are spoken (a polite live region), not every recipe.
  import { api, ApiError } from '../lib/api';
  import { announcement, cookRun, duration, runUi, setRun } from '../lib/cookidooRun.svelte';
  import { fmt, t } from '../lib/i18n';

  const run = $derived(cookRun.run);
  const running = $derived(run?.state === 'running');
  const pct = $derived(run && run.total > 0 ? Math.round((run.done / run.total) * 100) : 0);
  const spoken = $derived(announcement(run));
  let stopping = $state(false);
  let error = $state('');

  const counts = $derived(
    run ? (['adopted', 'updated', 'pictures', 'no_picture', 'fresh', 'no_nutrition', 'failed'] as const).filter((k) => (run[k] ?? 0) > 0).map((k) => t(`cbCnt_${k}`, { n: fmt(run[k] ?? 0) })) : [],
  );
  const whyStopped = $derived(
    !run ? '' : run.error_kind ? t(`cbErr_${run.error_kind}`) : run.reason_kind ? t(`cbReason_${run.reason_kind}`) : '',
  );
  const failureText = (kind: string) => t(`cbErr_${kind}`);

  async function stop() {
    stopping = true;
    error = '';
    try { await api.cookidooImportCancel(); const next = await api.cookidooImport(); setRun(next); } catch (err) {
      error = err instanceof ApiError && typeof err.detail === 'string' ? err.detail : t('failed', { reason: err instanceof ApiError ? err.status : 'error' });
    } finally { stopping = false; }
  }
</script>

{#if run && run.started_at !== runUi.hidden}
  <section class="run" class:ended={!running} aria-labelledby="cb-run-title" data-testid="bulk-run">
    <h3 id="cb-run-title" class="micro quiet">{run.mode === 'pictures' ? t('cbRunTitlePictures') : t('cbRunTitle')}</h3>
    <span class="sr" role="status" aria-live="polite">{spoken}</span>
    {#if running}
      <div class="bar" role="progressbar" aria-label={t('cbRunAria')} aria-valuemin="0" aria-valuemax={run.total} aria-valuenow={run.done}
        aria-valuetext={t('cbProgress', { done: fmt(run.done), total: fmt(run.total) })}><i style="width:{Math.max(pct, 3)}%"></i></div>
      <p class="line"><strong class="mono">{t('cbProgress', { done: fmt(run.done), total: fmt(run.total) })}</strong>
        {#if run.eta_seconds > 0}<span class="quiet"> · {t('cbEta', { t: duration(run.eta_seconds) })}</span>{/if}</p>
      {#if run.current}<p class="note cur" aria-hidden="true">{t('cbCurrent', { name: run.current })}</p>{/if}
    {:else if run.state === 'done'}
      <p class="line"><strong>{run.mode === 'pictures' ? t('cbDonePictures', { n: fmt(run.done) }) : t('cbDone', { n: fmt(run.done) })}</strong></p>
    {:else}
      <p class="line"><strong>{run.state === 'cancelled' && run.reason_kind === 'user' ? t('cbCancelled', { done: fmt(run.done), total: fmt(run.total) }) : t('cbStopped', { done: fmt(run.done), total: fmt(run.total), why: whyStopped })}</strong></p>
    {/if}
    {#if counts.length}<p class="note counts">{counts.join(' · ')}</p>{/if}
    {#if run.groups.length}<p class="note">{t('cbGroupsMade', { names: run.groups.join(', ') })}</p>{/if}
    {#if run.failures.length && !running}
      <details class="fails">
        <summary>{t('cbFailures', { n: fmt(run.failed + run.no_nutrition) })}</summary>
        <ul>{#each run.failures as f (f.id)}<li><span>{f.name}</span><small>{failureText(f.kind)}</small></li>{/each}</ul>
      </details>
    {/if}
    {#if error}<p class="note warn" role="alert">{error}</p>{/if}
    <div class="acts">
      {#if running}
        <button type="button" class="btn" onclick={stop} disabled={stopping || run.cancelling}>{stopping || run.cancelling ? t('cbStopping') : t('cbStop')}</button>
      {:else}
        <button type="button" class="btn" onclick={() => (runUi.hidden = run.started_at)}>{t('cbClose')}</button>
      {/if}
    </div>
  </section>
{/if}

<style>
  .run { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 16px 18px 14px; display: flex; flex-direction: column; gap: 8px; border: 2px solid var(--green-text); }
  .run.ended { border-color: var(--hairline); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .bar { height: 10px; border-radius: 5px; background: var(--track); overflow: hidden; }
  .bar i { display: block; height: 100%; border-radius: 5px; background: var(--bar); transition: width 300ms; }
  .line { font-size: 15px; }
  .cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .counts { font-family: var(--f-mono); font-size: 12px; }
  .acts { display: flex; gap: 8px; margin-top: 2px; }
  .fails summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-weight: 600; font-size: 14px; }
  .fails ul { list-style: none; margin: 0; padding: 0 0 6px; display: flex; flex-direction: column; gap: 4px; max-height: 30vh; overflow-y: auto; }
  .fails li { display: flex; flex-direction: column; font-size: 14px; }
  .fails small { color: var(--quiet); font-size: 12px; }
</style>
