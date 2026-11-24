<script lang="ts">
  // "Export my data": a ZIP with CSV files (Excel, Numbers) and one complete JSON file of the signed-in person's own data.
  // The download is a plain link: the browser sends the sign-in with it, and the server names the file.
  import { exportUrl, periodProblem, type ExportPeriod } from '../lib/dataExport';
  import { today } from '../lib/date';
  import { lang, t } from '../lib/i18n';
  import { localApi, localDownload } from '../lib/local';
  import { toast } from '../lib/store.svelte';

  const PERIODS: { id: ExportPeriod; label: () => string }[] = [
    { id: 'all', label: () => t('exAll') },
    { id: 'year', label: () => t('exYear') },
    { id: 'custom', label: () => t('exCustom') },
  ];

  let period = $state<ExportPeriod>('all');
  let from = $state('');
  let to = $state('');

  const problem = $derived(periodProblem(period, from, to));
  const href = $derived(exportUrl(period, from, to, today(), lang));
  // in the app there is no server behind the link: the file comes from the app host (lib/local.ts)
  const inApp = !!localApi();
  function appDownload(event: MouseEvent) {
    event.preventDefault();
    if (href) localDownload(href).catch((e) => toast(t('loadFailed', { reason: e instanceof Error ? e.message : 'error' })));
  }
</script>

<section class="icard" aria-labelledby="ex-title" data-testid="data-export">
  <h2 id="ex-title" class="micro quiet">{t('exTitle')}</h2>
  <p class="note">{t('exText')}</p>
  <div class="field">
    <span id="ex-period">{t('exPeriod')}</span>
    <div class="chips" role="group" aria-labelledby="ex-period">
      {#each PERIODS as p}
        <button type="button" class="chip" class:on={period === p.id} aria-pressed={period === p.id} onclick={() => (period = p.id)}>{p.label()}</button>
      {/each}
    </div>
  </div>
  {#if period === 'custom'}
    <div class="dates">
      <label class="field"><span>{t('rangeFrom')}</span><input type="date" bind:value={from} max={to || undefined} aria-invalid={problem ? 'true' : undefined} /></label>
      <label class="field"><span>{t('rangeTo')}</span><input type="date" bind:value={to} min={from || undefined} aria-invalid={problem ? 'true' : undefined} /></label>
    </div>
    {#if problem}<p class="note warn" role="alert">{t('exBad')}</p>{/if}
  {/if}
  {#if href}
    <a class="btn primary dl" {href} download onclick={inApp ? appDownload : undefined}>{t('exButton')}</a>
  {:else}
    <span class="btn primary dl off" role="link" aria-disabled="true">{t('exButton')}</span>
  {/if}
  <p class="note">{t('exHint')}</p>
</section>

<style>
  .chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .chip { border-radius: 22px 22px 22px 8px; }
  .dates { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .dl { align-self: flex-start; text-decoration: none; }
  .dl.off { opacity: 0.55; pointer-events: none; }
</style>
