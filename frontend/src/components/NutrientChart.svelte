<script lang="ts">
  import { fmtAmount, QUIET_COVERAGE } from '../lib/nutrients.svelte';
  import { diffDays, labelIndexes } from '../lib/insightsRange';
  import { fmt, t } from '../lib/i18n';
  import { sectionLabel, sectionShort } from '../lib/sections';
  import type { NutrientCurve } from '../lib/types';

  // One nutrient over time: a line of the mean per day with entries. Where fewer than 20 % of the calories have a value
  // the line is thin and dashed and the points are hollow: the figure is probably too low there.
  let { curve, name }: { curve: NutrientCurve; name: string } = $props();

  const gran = $derived(curve.granularity);
  const series = $derived(curve.series);
  const n = $derived(series.length);
  const known = (p: NutrientCurve['series'][number]) => p.average != null && p.coverage > 0;
  const low = (p: NutrientCurve['series'][number]) => p.coverage < QUIET_COVERAGE;
  const ref = $derived(curve.nrv != null ? { v: curve.nrv, label: t('nutRefNrv', { n: fmt(curve.nrv, curve.nrv < 10 ? 1 : 0), unit: curve.unit }) }
    : curve.goal != null ? { v: curve.goal, label: t('nutRefGoal', { n: fmt(curve.goal), unit: curve.unit }) } : null);

  let width = $state(320);
  const H = $derived(width > 700 ? 280 : 210);
  const PL = 46, PR = 8, PT = 14, PB = 26;
  const plotW = $derived(Math.max(80, width - PL - PR));
  const plotH = $derived(H - PT - PB);
  const values = $derived(series.filter(known).map((p) => p.average as number));
  const vmax = $derived.by(() => {
    const top = Math.max(...values, ref ? ref.v * 1.15 : 0, 1e-6);
    const mag = 10 ** Math.floor(Math.log10(top));
    const nice = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((c) => c >= top) ?? top;
    return nice;
  });
  const y = (v: number) => PT + plotH * (1 - v / vmax);
  const step = $derived(plotW / Math.max(n, 1));
  const cx = (i: number) => PL + step * (i + 0.5);
  const labels = $derived(labelIndexes(n, width < 500 ? 4 : width < 800 ? 6 : 9));
  const multiYear = $derived(n > 0 && diffDays(series[0].start, series[n - 1].end) > 366);
  const edge = $derived(step < 36);
  const anchor = (i: number) => (labels.length < 2 || !edge ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
  const dots = $derived(n <= 90);

  const segs = $derived.by(() => {
    const out: { d: string; low: boolean }[] = [];
    for (let i = 1; i < n; i += 1) {
      const a = series[i - 1], b = series[i];
      if (!known(a) || !known(b)) continue;
      out.push({ d: `M${cx(i - 1).toFixed(1)} ${y(a.average as number).toFixed(1)}L${cx(i).toFixed(1)} ${y(b.average as number).toFixed(1)}`, low: low(a) || low(b) });
    }
    return out;
  });
  const grid = $derived([0, vmax / 2, vmax]);
  const fmtV = (v: number) => fmtAmount(v, curve.unit);
  const axis = (v: number) => fmt(v, v >= 100 ? 0 : v >= 10 ? 0 : v >= 1 ? 1 : 2);

  let sel = $state<number | null>(null);
  $effect(() => { series; sel = null; });
  const readout = $derived.by(() => {
    if (sel == null || !series[sel]) return t('chartTapPoint');
    const p = series[sel];
    const label = sectionLabel(p, gran);
    return known(p) ? t('nutReadout', { label, value: fmtV(p.average as number), cov: fmt(Math.round(p.coverage * 100)) }) : t('nutReadoutNone', { label });
  });
  const mean = $derived(values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const aria = $derived(t('nutAria', { name, unit: curve.unit, n: values.length, avg: fmtV(mean), max: fmtV(Math.max(0, ...values)) }));
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
  const anyLow = $derived(series.some((p) => known(p) && low(p)));
</script>

<div class="wrap" bind:clientWidth={width}>
  <p class="readout mono" aria-live="polite">{readout}</p>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg {width} height={H} viewBox="0 0 {width} {H}" role="group" aria-label="{aria}. {t('chartKeys')}" tabindex="0" onkeydown={key} onblur={() => (sel = null)}>
    {#each grid as g, gi}
      <path d="M{PL} {y(g)}H{width - PR}" stroke="var(--hairline)" stroke-width={gi === 0 ? 2 : 1.5} stroke-dasharray={gi === 0 ? undefined : '3 4'} />
      <text x={PL - 7} y={y(g) + 4} text-anchor="end" class="lab">{axis(g)}</text>
    {/each}
    {#if ref && ref.v <= vmax}
      <path d="M{PL} {y(ref.v)}H{width - PR}" stroke="var(--text)" stroke-width="2" stroke-dasharray="7 4" />
      <text x={width - PR - 2} y={y(ref.v) - 5} text-anchor="end" class="lab halo">{ref.label}</text>
    {/if}
    {#if sel != null}<rect x={PL + step * sel} y={PT - 2} width={step} height={plotH + 2} fill="var(--text)" opacity="0.1" />{/if}
    {#each segs as sg}
      <path d={sg.d} fill="none" stroke="var(--bar)" stroke-width={sg.low ? 1.8 : 3.5} stroke-dasharray={sg.low ? '3 5' : undefined} stroke-linecap="round" stroke-linejoin="round" />
    {/each}
    {#if dots}
      {#each series as p, i (p.start)}
        {#if known(p)}
          <circle cx={cx(i)} cy={y(p.average as number)} r={low(p) ? 3 : 3.4} fill={low(p) ? 'var(--paper)' : 'var(--bar)'} stroke="var(--bar)" stroke-width="1.8" />
        {/if}
      {/each}
    {/if}
    {#if sel != null && known(series[sel]) && !dots}
      <circle cx={cx(sel)} cy={y(series[sel].average as number)} r="4.5" fill="var(--orange)" stroke="var(--paper)" stroke-width="2" />
    {/if}
    {#each labels as i (i)}
      <text x={cx(i) + (labels.length < 2 || !edge ? 0 : i === 0 ? -step / 2 + 1 : i === n - 1 ? step / 2 - 1 : 0)} y={H - 7} text-anchor={anchor(i)} class="lab">{sectionShort(series[i], gran, multiYear)}</text>
    {/each}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <rect x={PL} y="0" width={plotW} height={H} fill="transparent" onpointermove={(e) => { if (e.pointerType === 'mouse') sel = at(e); }}
      onpointerdown={(e) => (sel = at(e))} onpointerleave={(e) => { if (e.pointerType === 'mouse') sel = null; }} />
  </svg>
  <ul class="legend mono">
    <li><svg width="22" height="10" aria-hidden="true"><path d="M1 5H21" stroke="var(--bar)" stroke-width="3.5" stroke-linecap="round" /></svg>{t('nutMean')} {fmtV(mean)}</li>
    {#if anyLow}
      <li><svg width="22" height="10" aria-hidden="true"><path d="M1 5H21" stroke="var(--bar)" stroke-width="1.8" stroke-dasharray="3 5" stroke-linecap="round" /><circle cx="11" cy="5" r="3" fill="var(--paper)" stroke="var(--bar)" stroke-width="1.8" /></svg>&lt; 20 %</li>
    {/if}
  </ul>
  {#if anyLow}<p class="note">{t('nutLow')}</p>{/if}
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  svg { display: block; touch-action: pan-y; border-radius: 12px; }
  svg:focus-visible { outline: 3px solid var(--focus-base); outline-offset: 2px; }
  .readout { font-size: 13px; font-weight: 500; min-height: 34px; display: flex; align-items: center; }
  .lab { font-family: var(--f-mono); font-size: 11px; fill: var(--quiet); }
  .halo { paint-order: stroke; stroke: var(--paper); stroke-width: 4px; stroke-linejoin: round; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 12px; color: var(--quiet); }
  .legend li { display: inline-flex; align-items: center; gap: 6px; }
</style>
