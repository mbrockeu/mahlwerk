<script lang="ts">
  import { fmt, t } from '../lib/i18n';
  import { fmtAmount, nutrientName, QUIET_COVERAGE } from '../lib/nutrients.svelte';
  import type { NutrientUnit } from '../lib/types';
  import TickBar from './TickBar.svelte';

  // One nutrient with its amount, the share of the EU reference intake as a tick scale, and how well it is known.
  let { key, unit, amount, nrv, coverage }:
    { key: string; unit: NutrientUnit; amount: number; nrv: number | null; coverage: number } = $props();

  const name = $derived(nutrientName(key));
  const percent = $derived(nrv ? (amount / nrv) * 100 : null);
  // below this coverage the figure says little: shown quietly, never as a shortage
  const quiet = $derived(coverage < QUIET_COVERAGE);
  const value = $derived(fmtAmount(amount, unit));
  const coverageText = $derived(t('microCoverage', { n: fmt(Math.round(coverage * 100)) }));
</script>

<li class="mrow" class:quiet>
  <div class="line">
    <strong>{name}</strong>
    <span class="mono val">{value}</span>
  </div>
  {#if nrv && percent !== null}
    <TickBar value={amount} goal={nrv} track="var(--track)" fill={quiet ? 'var(--bar-soft)' : 'var(--bar)'} height={8}
      label={t('microAria', { name, value, percent: `${fmt(Math.round(percent))} %` })} />
    <div class="sub"><span>{t('microNrv', { n: fmt(Math.round(percent)) })}</span><span>{coverageText}</span></div>
  {:else}
    <div class="sub"><span>{t('microNoRef')}</span><span>{coverageText}</span></div>
  {/if}
</li>

<style>
  .mrow { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .line { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  strong { font-size: 14px; font-weight: 600; line-height: 1.2; min-width: 0; }
  .val { font-size: 14px; font-weight: 600; white-space: nowrap; }
  .sub { display: flex; flex-direction: column; gap: 1px; font-size: 12px; color: var(--quiet); }
  .quiet strong, .quiet .val { color: var(--quiet); font-weight: 500; }
</style>
