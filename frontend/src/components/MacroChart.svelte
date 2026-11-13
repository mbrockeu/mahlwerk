<script lang="ts">
  import { diffDays, labelIndexes, macroShares } from '../lib/insightsRange';
  import { fmt, t } from '../lib/i18n';
  import { sectionLabel, sectionShort } from '../lib/sections';
  import type { Granularity, Section } from '../lib/types';

  // Share of protein, carbohydrates and fat in the calories, one stacked column per section (100 % tall).
  let { series, gran }: { series: Section[]; gran: Granularity } = $props();

  const COLORS = { protein: 'var(--orange)', carbs: 'var(--lime)', fat: 'var(--pink)' } as const;
  const KEYS = ['protein', 'carbs', 'fat'] as const;
  const NAMES = $derived({ protein: t('protein'), carbs: t('carbs'), fat: t('fat') });

  let width = $state(320);
  const H = $derived(width > 700 ? 200 : 170);
  const PL = 44, PR = 4, PT = 8, PB = 26;
  const n = $derived(series.length);
  const plotW = $derived(Math.max(80, width - PL - PR));
  const plotH = $derived(H - PT - PB);
  const step = $derived(plotW / Math.max(n, 1));
  const bw = $derived(Math.max(1.2, step - (step >= 5 ? 2 : step >= 2.5 ? 1 : 0)));
  const x0 = (i: number) => PL + step * i + (step - bw) / 2;
  const shares = $derived(series.map((s) => (s.logged_days > 0 ? macroShares(s) : null)));
  const labels = $derived(labelIndexes(n, width < 500 ? 4 : width < 800 ? 6 : 9));
  const multiYear = $derived(n > 0 && diffDays(series[0].start, series[n - 1].end) > 366);
  const edge = $derived(step < 36);
  const anchor = (i: number) => (labels.length < 2 || !edge ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');

  // overall shares: sections weighted by their logged days
  const total = $derived.by(() => {
    const w = series.reduce((s, x) => s + x.logged_days, 0);
    if (!w) return null;
    const mean = (k: (typeof KEYS)[number]) => series.reduce((s, x) => s + x[k] * x.logged_days, 0) / w;
    return macroShares({ protein: mean('protein'), carbs: mean('carbs'), fat: mean('fat') });
  });
  const pct = (v: number) => fmt(Math.round(v * 100));
  const list = $derived(total ? KEYS.map((k) => `${NAMES[k]} ${pct(total[k])} %`).join(', ') : '');

  let sel = $state<number | null>(null);
  $effect(() => { series; sel = null; });
  const readout = $derived.by(() => {
    if (sel == null || !series[sel]) return t('chartTap');
    const label = sectionLabel(series[sel], gran);
    const s = shares[sel];
    return s ? t('macroReadout', { label, p: pct(s.protein), c: pct(s.carbs), f: pct(s.fat) }) : t('macroNone', { label });
  });
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

<div class="wrap" bind:clientWidth={width}>
  <p class="readout mono" aria-live="polite">{readout}</p>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg {width} height={H} viewBox="0 0 {width} {H}" role="group" aria-label="{t('macroTrendAria', { list })}. {t('chartKeys')}" tabindex="0" onkeydown={key} onblur={() => (sel = null)}>
    {#each [0, 0.5, 1] as g}
      <path d="M{PL} {PT + plotH * (1 - g)}H{width - PR}" stroke="var(--hairline)" stroke-width="1.5" stroke-dasharray={g === 0 ? undefined : '3 4'} />
      <text x={PL - 6} y={PT + plotH * (1 - g) + 4} text-anchor="end" class="lab">{g * 100} %</text>
    {/each}
    {#each series as s, i (s.start)}
      {@const sh = shares[i]}
      {#if sel === i}<rect x={PL + step * i} y={PT - 2} width={step} height={plotH + 2} fill="var(--text)" opacity="0.1" />{/if}
      {#if sh}
        {@const hp = plotH * sh.protein}
        {@const hc = plotH * sh.carbs}
        {@const hf = plotH * sh.fat}
        <rect x={x0(i)} y={PT + plotH - hp} width={bw} height={hp} fill={COLORS.protein} />
        <rect x={x0(i)} y={PT + plotH - hp - hc} width={bw} height={hc} fill={COLORS.carbs} />
        <rect x={x0(i)} y={PT + plotH - hp - hc - hf} width={bw} height={hf} fill={COLORS.fat} />
      {:else}
        <circle cx={PL + step * (i + 0.5)} cy={PT + plotH - 3} r="1.6" fill="var(--dim)" />
      {/if}
    {/each}
    {#each labels as i (i)}
      <text x={PL + step * (i + 0.5) + (labels.length < 2 || !edge ? 0 : i === 0 ? -step / 2 + 1 : i === n - 1 ? step / 2 - 1 : 0)} y={H - 7} text-anchor={anchor(i)} class="lab">{sectionShort(series[i], gran, multiYear)}</text>
    {/each}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <rect x={PL} y="0" width={plotW} height={H} fill="transparent" onpointermove={(e) => { if (e.pointerType === 'mouse') sel = at(e); }}
      onpointerdown={(e) => (sel = at(e))} onpointerleave={(e) => { if (e.pointerType === 'mouse') sel = null; }} />
  </svg>
  {#if total}
    <ul class="legend">
      {#each KEYS as k}
        <li><span class="sw" style="background:{COLORS[k]}"></span>{NAMES[k]} <b class="mono">{t('macroShareLabel', { label: '', n: pct(total[k]) }).trim()}</b></li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  svg { display: block; touch-action: pan-y; border-radius: 12px; }
  svg:focus-visible { outline: 3px solid var(--focus-base); outline-offset: 2px; }
  .readout { font-size: 13px; font-weight: 500; min-height: 34px; display: flex; align-items: center; }
  .lab { font-family: var(--f-mono); font-size: 11px; fill: var(--quiet); }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 13px; }
  .legend li { display: inline-flex; align-items: center; gap: 7px; }
  .legend b { font-size: 13px; font-weight: 600; }
  .sw { width: 14px; height: 14px; border-radius: 5px 5px 5px 2px; border: 1px solid color-mix(in srgb, var(--text) 25%, transparent); }
</style>
