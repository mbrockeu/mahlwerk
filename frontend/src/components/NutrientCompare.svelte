<script lang="ts">
  import { fmtAmount } from '../lib/nutrients.svelte';
  import { diffDays, labelIndexes } from '../lib/insightsRange';
  import { fmt, t } from '../lib/i18n';
  import { sectionLabel, sectionShort } from '../lib/sections';
  import { markerPath, markerStride, percentMax, pointsOf, spreadLabels, SERIES_STYLES, type Pt, type Ref, type Summary } from '../lib/nutrientCompare';
  import SeriesMark from './SeriesMark.svelte';
  import TickBar from './TickBar.svelte';
  import type { NutrientCurve } from '../lib/types';

  // Two to four nutrients on one axis in percent of their reference amount. A line differs by dash pattern and marker, not by
  // colour alone, and carries its name at its end (wide) or in the rows below (always). Sections without a value are gaps. Where
  // fewer than 20 % of the calories have a value the line is thin and its points hollow: probably too low, not a shortage.
  let { curves, names, refs, summaries }: { curves: NutrientCurve[]; names: string[]; refs: Ref[]; summaries: Summary[] } = $props();

  const gran = $derived(curves[0].granularity);
  const sections = $derived(curves[0].series);
  const n = $derived(sections.length);
  const pts = $derived<Pt[][]>(curves.map((c, i) => pointsOf(c.series, refs[i])));

  let width = $state(320);
  const wide = $derived(width >= 640);
  const H = $derived(width > 700 ? 300 : 230);
  const PL = 46, PT = 14, PB = 26;
  const PR = $derived(wide ? 112 : 10);
  const plotW = $derived(Math.max(80, width - PL - PR));
  const plotH = $derived(H - PT - PB);
  const vmax = $derived(percentMax(Math.max(0, ...pts.flatMap((s) => s.map((p) => p.pct ?? 0)))));
  const y = (v: number) => PT + plotH * (1 - v / vmax);
  const step = $derived(plotW / Math.max(n, 1));
  const cx = (i: number) => PL + step * (i + 0.5);
  const labels = $derived(labelIndexes(n, width < 500 ? 4 : width < 800 ? 6 : 9));
  const multiYear = $derived(n > 0 && diffDays(sections[0].start, sections[n - 1].end) > 366);
  const edge = $derived(step < 36);
  const anchor = (i: number) => (labels.length < 2 || !edge ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
  const gridStep = $derived(vmax <= 250 ? 50 : vmax <= 600 ? 100 : vmax <= 1500 ? 250 : vmax / 4);
  const grid = $derived(Array.from({ length: Math.floor(vmax / gridStep) + 1 }, (_, k) => k * gridStep).filter((v) => v === 0 || Math.abs(v - 100) > gridStep / 3));
  const stride = $derived(markerStride(step));
  const R = 4;

  const segs = $derived(pts.map((s) => {
    const out: { d: string; low: boolean }[] = [];
    for (let i = 1; i < n; i += 1) {
      const a = s[i - 1], b = s[i];
      if (a.pct == null || b.pct == null) continue; // a gap stays a gap
      out.push({ d: `M${cx(i - 1).toFixed(1)} ${y(a.pct).toFixed(1)}L${cx(i).toFixed(1)} ${y(b.pct).toFixed(1)}`, low: a.low || b.low });
    }
    return out;
  }));
  // names at the line ends (wide only), pushed apart where lines end close together
  const endLabels = $derived.by(() => {
    if (!wide) return [] as { i: number; y: number; x: number }[];
    const last = pts.map((s) => { for (let i = n - 1; i >= 0; i -= 1) if (s[i].pct != null) return s[i].pct as number; return null; });
    const idx = last.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
    const ys = spreadLabels(idx.map((i) => y(last[i] as number)), 15, PT + 6, PT + plotH);
    return idx.map((i, k) => ({ i, y: ys[k], x: width - PR + 8 }));
  });

  let sel = $state<number | null>(null);
  $effect(() => { sections; sel = null; });
  const label = $derived(sel != null && sections[sel] ? sectionLabel(sections[sel], gran) : '');
  const fmtV = (v: number, i: number) => fmtAmount(v, curves[i].unit);
  const pctText = (v: number) => `${fmt(Math.round(v))} %`;
  const refName = (i: number) => (refs[i].kind === 'goal' ? t('nutOfGoal') : t('nutOfNrv'));
  const aria = $derived(t('nutCmpAria', { n: curves.length, list: names.map((nm, i) => `${nm} ${summaries[i].mean != null ? pctText(summaries[i].pct ?? 0) : t('nutRowNone')}`).join(', ') }));
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
  const anyLow = $derived(pts.some((s) => s.some((p) => p.low)));
</script>

<div class="wrap" bind:clientWidth={width}>
  <div class="readout" aria-live="polite" style="min-height:{Math.max(64, 30 + curves.length * 22)}px">
    {#if sel != null && sections[sel]}
      <p class="when mono">{label}</p>
      <ul class="vals">
        {#each curves as c, i}
          {@const p = pts[i][sel]}
          <li class:quiet={p.low}>
            <SeriesMark {i} width={26} hollow={p.low} /><strong>{names[i]}</strong>
            {#if p.value != null}<span class="mono">{fmtV(p.value, i)} · {pctText(p.pct ?? 0)}</span>{#if p.low}<em class="lowtag">{t('nutLowTag')}</em>{/if}
            {:else}<span class="mono dim">{t('nutNoValue')}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else}<p class="when mono">{t('nutCmpTap')}</p>{/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg {width} height={H} viewBox="0 0 {width} {H}" role="group" aria-label="{aria}. {t('nutPctAria')}. {t('chartKeys')}" tabindex="0" onkeydown={key} onblur={() => (sel = null)}>
    {#each grid as g}
      <path d="M{PL} {y(g)}H{width - PR}" stroke="var(--hairline)" stroke-width={g === 0 ? 2 : 1.5} stroke-dasharray={g === 0 ? undefined : '3 4'} />
      <text x={PL - 7} y={y(g) + 4} text-anchor="end" class="lab">{g} %</text>
    {/each}
    <path d="M{PL} {y(100)}H{width - PR}" stroke="var(--text)" stroke-width="2.4" />
    <text x={PL - 7} y={y(100) + 4} text-anchor="end" class="lab strong">100 %</text>
    {#if sel != null}<rect x={PL + step * sel} y={PT - 2} width={step} height={plotH + 2} fill="var(--text)" opacity="0.1" />{/if}
    {#each segs as list, si}
      {@const st = SERIES_STYLES[si]}
      {#each list as sg}
        <path d={sg.d} fill="none" stroke={st.color} stroke-width={sg.low ? 1.8 : 3} stroke-dasharray={st.dash} opacity={sg.low ? 0.6 : 1} stroke-linecap="round" stroke-linejoin="round" />
      {/each}
    {/each}
    {#each pts as s, si}
      {@const st = SERIES_STYLES[si]}
      {#each s as p, i}
        {#if p.pct != null && (i % stride === 0 || i === n - 1 || sel === i)}
          <path d={markerPath(st.shape, cx(i), y(p.pct), sel === i ? R + 1.5 : R)} fill={p.low ? 'var(--paper)' : st.color} stroke={st.color} stroke-width="1.8" stroke-linejoin="round" />
        {/if}
      {/each}
    {/each}
    {#each endLabels as el (el.i)}
      <path d={markerPath(SERIES_STYLES[el.i].shape, el.x - 1, el.y - 3.5, 3.2)} fill={SERIES_STYLES[el.i].color} />
      <text x={el.x + 8} y={el.y} class="lab name">{names[el.i].length > 13 ? `${names[el.i].slice(0, 12)}…` : names[el.i]}</text>
    {/each}
    {#each labels as i (i)}
      <text x={cx(i) + (labels.length < 2 || !edge ? 0 : i === 0 ? -step / 2 + 1 : i === n - 1 ? step / 2 - 1 : 0)} y={H - 7} text-anchor={anchor(i)} class="lab">{sectionShort(sections[i], gran, multiYear)}</text>
    {/each}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <rect x={PL} y="0" width={plotW} height={H} fill="transparent" onpointermove={(e) => { if (e.pointerType === 'mouse') sel = at(e); }}
      onpointerdown={(e) => (sel = at(e))} onpointerleave={(e) => { if (e.pointerType === 'mouse') sel = null; }} />
  </svg>
  <p class="axis mono">{t('nutAxis')}</p>

  <ul class="rows">
    {#each curves as c, i}
      {@const sm = summaries[i]}
      <li class="mrow" class:quiet={sm.low}>
        <div class="line"><span class="who"><SeriesMark {i} width={30} hollow={sm.low} /><strong>{names[i]}</strong></span>
          {#if sm.mean != null}<span class="mono val">{fmtV(sm.mean, i)}</span>{/if}</div>
        {#if sm.mean != null}
          <TickBar value={sm.mean} goal={refs[i].value} track="var(--track)" fill={sm.low ? 'var(--bar-soft)' : SERIES_STYLES[i].color} height={8}
            label={t('microAria', { name: names[i], value: fmtV(sm.mean, i), percent: pctText(sm.pct ?? 0) })} />
          <div class="sub"><span><b>{t('nutRowPct', { n: fmt(Math.round(sm.pct ?? 0)), ref: refName(i) })}</b></span>
            <span class:lowline={sm.low}>{t('microCoverage', { n: fmt(Math.round((sm.coverage ?? 0) * 100)) })}{#if sm.low}&nbsp;· <em class="lowtag">{t('nutLowTag')}</em>{/if}</span></div>
        {:else}<div class="sub"><span>{t('nutRowNone')}</span></div>{/if}
      </li>
    {/each}
  </ul>
  {#if anyLow || summaries.some((s) => s.low)}<p class="note">{t('nutLowCmp')}</p>{/if}
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
  .lab.strong { fill: var(--text); font-weight: 600; }
  .lab.name { fill: var(--text); font-family: var(--f-body); font-size: 12px; font-weight: 600; }
  .axis { font-size: 11px; color: var(--quiet); margin-top: -2px; }
  .rows { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 14px 28px; margin-top: 6px; }
  .mrow { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .line { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .who { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
  .line strong { font-size: 14px; font-weight: 600; }
  .val { font-size: 14px; font-weight: 600; white-space: nowrap; }
  .sub { display: flex; flex-direction: column; gap: 1px; font-size: 12px; color: var(--quiet); }
  .sub b { font-weight: 600; color: var(--text); }
  .mrow.quiet strong, .mrow.quiet .val { color: var(--quiet); font-weight: 500; }
  .lowtag { font-style: normal; font-family: var(--f-mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; padding: 1px 7px; border-radius: 8px 8px 8px 3px; background: var(--track); color: var(--text); }
  .lowline { color: var(--text); }
</style>
