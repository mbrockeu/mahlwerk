<script lang="ts">
  import { labelIndexes } from '../lib/insightsRange';
  import { t } from '../lib/i18n';

  // Small bar chart with keyboard selection and a text readout: used for a food's months and weekdays.
  let { values, labels, readouts, aria, height = 110, wantLabels = 5 }:
    { values: number[]; labels: string[]; readouts: string[]; aria: string; height?: number; wantLabels?: number } = $props();

  let width = $state(280);
  const PT = 6, PB = 22;
  const n = $derived(values.length);
  const max = $derived(Math.max(...values, 1));
  const step = $derived(width / Math.max(n, 1));
  const bw = $derived(Math.max(2, Math.min(step * 0.62, 28)));
  const y = (v: number) => PT + (height - PT - PB) * (1 - v / max);
  const idx = $derived(labelIndexes(n, Math.min(n, wantLabels)));
  let sel = $state<number | null>(null);
  $effect(() => { values; sel = null; });
  function key(e: KeyboardEvent) {
    if (!n) return;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = sel == null ? 0 : sel + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = sel == null ? n - 1 : sel - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next == null) return;
    e.preventDefault();
    sel = Math.max(0, Math.min(n - 1, next));
  }
  const at = (e: PointerEvent) => {
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n)));
  };
</script>

<div bind:clientWidth={width} class="mb">
  <p class="readout mono" aria-live="polite">{sel != null ? readouts[sel] : t('chartTap')}</p>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg {width} {height} viewBox="0 0 {width} {height}" role="group" aria-label="{aria}. {t('chartKeys')}" tabindex="0" onkeydown={key} onblur={() => (sel = null)}>
    <path d="M0 {y(0)}H{width}" stroke="var(--hairline)" stroke-width="2" />
    {#each values as v, i}
      {#if sel === i}<rect x={step * i} y={PT - 2} width={step} height={height - PT - PB + 2} rx="3" fill="var(--text)" opacity="0.1" />{/if}
      {#if v > 0}<path d="M{step * (i + 0.5)} {y(0)}V{y(v)}" stroke="var(--bar)" stroke-width={bw} stroke-dasharray="4 2" />
      {:else}<circle cx={step * (i + 0.5)} cy={y(0) - 3} r="1.6" fill="var(--dim)" />{/if}
    {/each}
    {#each idx as i}
      <text x={step * (i + 0.5)} y={height - 6} text-anchor={idx.length > 1 && i === 0 ? 'start' : idx.length > 1 && i === n - 1 ? 'end' : 'middle'} class="lab">{labels[i]}</text>
    {/each}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <rect x="0" y="0" {width} {height} fill="transparent" onpointermove={(e) => { if (e.pointerType === 'mouse') sel = at(e); }}
      onpointerdown={(e) => (sel = at(e))} onpointerleave={(e) => { if (e.pointerType === 'mouse') sel = null; }} />
  </svg>
</div>

<style>
  .mb { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  svg { display: block; touch-action: pan-y; border-radius: 10px; }
  svg:focus-visible { outline: 3px solid var(--focus-base); outline-offset: 2px; }
  .readout { font-size: 12.5px; font-weight: 500; min-height: 32px; display: flex; align-items: center; }
  .lab { font-family: var(--f-mono); font-size: 10.5px; fill: var(--quiet); }
</style>
