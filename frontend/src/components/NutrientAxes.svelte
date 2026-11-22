<script lang="ts">
  import { fmtAmount } from '../lib/nutrients.svelte';
  import { diffDays, labelIndexes } from '../lib/insightsRange';
  import { fmt, t } from '../lib/i18n';
  import { sectionLabel, sectionShort } from '../lib/sections';
  import { axisMax, markerPath, markerStride, pointsOf, SERIES_STYLES, type AxisChart, type Pt, type Ref, type Summary } from '../lib/nutrientCompare';
  import SeriesMark from './SeriesMark.svelte';
  import type { NutrientCurve } from '../lib/types';

  // Up to four nutrients in their own units: the first unit on the left axis, a second one on the right (`chart` says which
  // nutrients and units). Each nutrient's reference (goal or EU reference amount) is a thin dashed line in its colour on its
  // axis. Lines differ by dash pattern and marker, not by colour alone; the rows below name them, their axis and reference.
  let { curves, names, refs, summaries, chart }:
    { curves: NutrientCurve[]; names: string[]; refs: (Ref | null)[]; summaries: Summary[]; chart: AxisChart } = $props();

  const idx = $derived(chart.series);
  const first = $derived(curves[idx[0]]);
  const gran = $derived(first.granularity);
  const sections = $derived(first.series);
  const n = $derived(sections.length);
  const pts = $derived<Pt[][]>(curves.map((c) => pointsOf(c.series, null)));
  const side = (i: number): 'left' | 'right' => (curves[i].unit === chart.left ? 'left' : 'right');

  let width = $state(320);
  const H = $derived(width > 700 ? 300 : 240);
  const PT = 22, PB = 26;
  const PL = 48;
  const PR = $derived(chart.right ? 48 : 10);
  const plotW = $derived(Math.max(80, width - PL - PR));
  const plotH = $derived(H - PT - PB);
  // each axis holds its lines and their references, with some air above
  const top = (s: 'left' | 'right') => axisMax(1.05 * Math.max(1e-6, ...idx.filter((i) => side(i) === s).flatMap((i) => [
    ...pts[i].map((p) => p.value ?? 0), refs[i]?.value ?? 0,
  ])));
  const vmaxL = $derived(top('left'));
  const vmaxR = $derived(chart.right ? top('right') : 1);
  const y = (v: number, s: 'left' | 'right') => PT + plotH * (1 - v / (s === 'left' ? vmaxL : vmaxR));
  const step = $derived(plotW / Math.max(n, 1));
  const cx = (i: number) => PL + step * (i + 0.5);
  const labels = $derived(labelIndexes(n, width < 500 ? 4 : width < 800 ? 6 : 9));
  const multiYear = $derived(n > 0 && diffDays(sections[0].start, sections[n - 1].end) > 366);
  const edge = $derived(step < 36);
  const anchor = (i: number) => (labels.length < 2 || !edge ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
  const stride = $derived(markerStride(step));
  const R = 3.2;
  const FR = [0, 0.25, 0.5, 0.75, 1];
  const axis = (v: number) => fmt(v, v === 0 || v >= 10 ? 0 : v >= 1 ? 1 : 2);

  const segs = $derived(idx.map((si) => {
    const s = pts[si], sd = side(si);
    const out: { d: string; low: boolean }[] = [];
    for (let i = 1; i < n; i += 1) {
      const a = s[i - 1], b = s[i];
      if (a.value == null || b.value == null) continue; // a gap stays a gap
      out.push({ d: `M${cx(i - 1).toFixed(1)} ${y(a.value, sd).toFixed(1)}L${cx(i).toFixed(1)} ${y(b.value, sd).toFixed(1)}`, low: a.low || b.low });
    }
    return { si, out };
  }));

  let sel = $state<number | null>(null);
  $effect(() => { sections; sel = null; });
  const label = $derived(sel != null && sections[sel] ? sectionLabel(sections[sel], gran) : '');
  const fmtV = (v: number, i: number) => fmtAmount(v, curves[i].unit);
  const refText = (i: number) => {
    const r = refs[i];
    return r ? t(r.kind === 'goal' ? 'nutRefGoal' : 'nutRefNrv', { n: fmt(r.value, r.value < 10 ? 1 : 0), unit: curves[i].unit }) : t('microNoRef');
  };
  const pctOf = (v: number, i: number) => { const r = refs[i]; return r ? ` · ${fmt(Math.round((v / r.value) * 100))} %` : ''; };
  const aria = $derived(t('nutAxesAria', { left: chart.left, right: chart.right ?? '–', list: idx.map((i) => names[i]).join(', ') }));
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
  const anyLow = $derived(idx.some((i) => pts[i].some((p) => p.low)));
</script>

<div class="wrap" bind:clientWidth={width}>
  <div class="readout" aria-live="polite" style="min-height:{Math.max(64, 30 + idx.length * 22)}px">
    {#if sel != null && sections[sel]}
      <p class="when mono">{label}</p>
      <ul class="vals">
        {#each idx as i (i)}
          {@const p = pts[i][sel]}
          <li class:quiet={p.low}>
            <SeriesMark {i} width={26} hollow={p.low} /><strong>{names[i]}</strong>
            {#if p.value != null}<span class="mono">{fmtV(p.value, i)}{pctOf(p.value, i)}</span>{#if p.low}<em class="lowtag">{t('nutLowTag')}</em>{/if}
            {:else}<span class="mono dim">{t('nutNoValue')}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else}<p class="when mono">{t('nutCmpTap')}</p>{/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg {width} height={H} viewBox="0 0 {width} {H}" role="group" aria-label="{aria}. {t('chartKeys')}" tabindex="0" onkeydown={key} onblur={() => (sel = null)}>
    <text x={PL - 7} y="11" text-anchor="end" class="lab unit">{chart.left}</text>
    {#if chart.right}<text x={width - PR + 7} y="11" text-anchor="start" class="lab unit">{chart.right}</text>{/if}
    {#each FR as f}
      <path d="M{PL} {PT + plotH * (1 - f)}H{width - PR}" stroke="var(--hairline)" stroke-width={f === 0 ? 2 : 1} stroke-dasharray={f === 0 ? undefined : '3 4'} />
      {#if f !== 0.25 && f !== 0.75}
        <text x={PL - 7} y={PT + plotH * (1 - f) + 4} text-anchor="end" class="lab">{axis(vmaxL * f)}</text>
        {#if chart.right}<text x={width - PR + 7} y={PT + plotH * (1 - f) + 4} text-anchor="start" class="lab">{axis(vmaxR * f)}</text>{/if}
      {/if}
    {/each}
    {#each idx as i (i)}
      {@const r = refs[i]}
      {#if r}<path d="M{PL} {y(r.value, side(i))}H{width - PR}" stroke={SERIES_STYLES[i].color} stroke-width="1.2" stroke-dasharray="2 4" opacity="0.85" />{/if}
    {/each}
    {#if sel != null}<rect x={PL + step * sel} y={PT - 2} width={step} height={plotH + 2} fill="var(--text)" opacity="0.1" />{/if}
    {#each segs as s (s.si)}
      {@const st = SERIES_STYLES[s.si]}
      {#each s.out as sg}
        <path d={sg.d} fill="none" stroke={st.color} stroke-width={sg.low ? 1.4 : 2} stroke-dasharray={st.dash} opacity={sg.low ? 0.6 : 1} stroke-linecap="round" stroke-linejoin="round" />
      {/each}
    {/each}
    {#each idx as si (si)}
      {@const st = SERIES_STYLES[si]}
      {#each pts[si] as p, i}
        {#if p.value != null && (i % stride === 0 || i === n - 1 || sel === i)}
          <path d={markerPath(st.shape, cx(i), y(p.value, side(si)), sel === i ? R + 1.5 : R)} fill={p.low ? 'var(--paper)' : st.color} stroke={st.color} stroke-width="1.4" stroke-linejoin="round" />
        {/if}
      {/each}
    {/each}
    {#each labels as i (i)}
      <text x={cx(i) + (labels.length < 2 || !edge ? 0 : i === 0 ? -step / 2 + 1 : i === n - 1 ? step / 2 - 1 : 0)} y={H - 7} text-anchor={anchor(i)} class="lab">{sectionShort(sections[i], gran, multiYear)}</text>
    {/each}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <rect x={PL} y="0" width={plotW} height={H} fill="transparent" onpointermove={(e) => { if (e.pointerType === 'mouse') sel = at(e); }}
      onpointerdown={(e) => (sel = at(e))} onpointerleave={(e) => { if (e.pointerType === 'mouse') sel = null; }} />
  </svg>

  <ul class="rows">
    {#each idx as i (i)}
      {@const sm = summaries[i]}
      <li class="mrow" class:quiet={sm.low}>
        <div class="line"><span class="who"><SeriesMark {i} width={30} hollow={sm.low} /><strong>{names[i]}</strong></span>
          {#if sm.mean != null}<span class="mono val">Ø {fmtV(sm.mean, i)}</span>{/if}</div>
        <div class="sub">
          <span><b>{refText(i)}</b>{#if sm.mean != null && refs[i]}{' · '}{t('nutRowPct', { n: fmt(Math.round(sm.pct ?? 0)), ref: refs[i]?.kind === 'goal' ? t('nutOfGoal') : t('nutOfNrv') })}{/if}</span>
          <span>{chart.right ? t(side(i) === 'left' ? 'nutAxisLeft' : 'nutAxisRight', { unit: curves[i].unit }) : ''}{#if sm.mean != null}{chart.right ? ' · ' : ''}{t('microCoverage', { n: fmt(Math.round((sm.coverage ?? 0) * 100)) })}{/if}{#if sm.low}&nbsp;· <em class="lowtag">{t('nutLowTag')}</em>{/if}</span>
        </div>
      </li>
    {/each}
  </ul>
  {#if anyLow}<p class="note">{t('nutLowCmp')}</p>{/if}
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  svg { display: block; touch-action: pan-y; border-radius: 12px; }
  svg:focus-visible { outline: 3px solid var(--focus-base); outline-offset: 2px; }
  .readout { background: var(--stone); border-radius: 16px 16px 16px 6px; padding: 9px 14px; display: flex; flex-direction: column; gap: 6px; justify-content: center; }
  .when { font-size: 12.5px; font-weight: 500; color: var(--quiet); }
  .vals { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 4px 18px; }
  .vals li { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; font-size: 13px; }
  .vals strong { font-weight: 600; }
  .vals .mono { font-size: 12.5px; }
  .dim, .quiet { color: var(--quiet); }
  .lab { font-family: var(--f-mono); font-size: 11px; fill: var(--quiet); }
  .lab.unit { fill: var(--text); font-weight: 600; }
  .rows { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 12px 28px; margin-top: 6px; }
  .mrow { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .line { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .who { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .line strong { font-size: 14px; font-weight: 600; }
  .val { font-size: 14px; font-weight: 600; white-space: nowrap; }
  .sub { display: flex; flex-direction: column; gap: 1px; font-size: 12px; color: var(--quiet); }
  .sub b { font-weight: 600; color: var(--text); }
  .mrow.quiet strong, .mrow.quiet .val { color: var(--quiet); font-weight: 500; }
  .lowtag { font-style: normal; font-family: var(--f-mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; padding: 1px 7px; border-radius: 8px 8px 8px 3px; background: var(--track); color: var(--text); }
</style>
