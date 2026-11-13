<script lang="ts">
  import { diffDays, labelIndexes } from '../lib/insightsRange';
  import { fmt, t } from '../lib/i18n';
  import { sectionLabel, sectionShort } from '../lib/sections';
  import type { Goal, Granularity, Section } from '../lib/types';

  // Calories per section (day, week or month): bars are the mean per logged day. The goal band stays, a second series
  // (outline) shows the period before. Click / Enter opens a section: zooms in, or opens the day view for single days.
  let { series, previous = null, goal, gran, onzoom }:
    { series: Section[]; previous?: Section[] | null; goal: Goal | null; gran: Granularity; onzoom: (s: Section) => void } = $props();

  let width = $state(320);
  const H = $derived(width > 700 ? 300 : 214);
  const PT = 12, PB = 28, PX = 6;
  const plotH = $derived(H - PT - PB);
  const plotW = $derived(Math.max(100, width - PX * 2));
  const n = $derived(series.length);
  const got = $derived(series.filter((s) => s.logged_days > 0));
  const prevAt = (i: number) => (previous && previous[i] && previous[i].logged_days > 0 ? previous[i] : null);
  const maxVal = $derived(Math.max(...series.map((s) => s.kcal), ...(previous ?? []).map((s) => s.kcal), goal ? goal.kcal * 1.2 : 0, 100));
  const y = (v: number) => PT + plotH - (v / maxVal) * plotH;
  const step = $derived(plotW / Math.max(n, 1));
  const bw = $derived(Math.max(1.5, Math.min(step * (step < 14 ? 0.62 : 0.7), 30)));
  const cx = (i: number) => PX + step * (i + 0.5);
  const multiYear = $derived(n > 0 && diffDays(series[0].start, series[n - 1].end) > 366);
  const labels = $derived(labelIndexes(n, width < 500 ? 4 : width < 800 ? 6 : width < 1100 ? 8 : 11));
  const edge = $derived(step < 36); // with few wide bars the labels sit under their bar, with many the outer ones hug the edges
  const anchor = (i: number) => (labels.length < 2 || !edge ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
  const shiftX = (i: number) => (labels.length < 2 || !edge ? 0 : i === 0 ? -step / 2 + 1 : i === n - 1 ? step / 2 - 1 : 0);
  // a section's own goal (it differs from the line when active energy is added to the goal), else the line's
  const upperOf = (s: Section) => (goal ? (s.goal_kcal ?? goal.kcal) * 1.1 : Infinity);

  let sel = $state<number | null>(null);
  $effect(() => { series; sel = null; });
  const readout = $derived.by(() => {
    if (sel == null || !series[sel]) return t('chartTap');
    const s = series[sel];
    const label = sectionLabel(s, gran);
    if (!s.logged_days) return t('barSectionNone', { label });
    const p = prevAt(sel);
    const text = t('barSection', { label, kcal: fmt(Math.round(s.kcal)), n: s.logged_days, days: s.days });
    return p ? `${text} · ${t('barPrev', { kcal: fmt(Math.round(p.kcal)) })}` : text;
  });

  // mean per logged day over the whole range (sections weighted by their logged days, so it matches the summary)
  const weight = $derived(got.reduce((s, b) => s + b.logged_days, 0));
  const avg = $derived(weight ? Math.round(got.reduce((s, b) => s + b.kcal * b.logged_days, 0) / weight) : 0);
  const lo = $derived(got.length ? Math.round(Math.min(...got.map((b) => b.kcal))) : 0);
  const hi = $derived(got.length ? Math.round(Math.max(...got.map((b) => b.kcal))) : 0);
  const title = $derived(gran === 'day' ? t('chartKcal') : gran === 'week' ? t('chartKcalWeekly') : t('chartKcalMonthly'));
  const aria = $derived(t('chartAria', { title, avg: fmt(avg), n: weight, min: fmt(lo), max: fmt(hi) }));

  function key(e: KeyboardEvent) {
    if (!n) return;
    if (e.key === 'Enter' || e.key === ' ') {
      if (sel != null) { e.preventDefault(); onzoom(series[sel]); }
      return;
    }
    const jump = e.key === 'PageUp' ? -7 : e.key === 'PageDown' ? 7 : 0;
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = sel == null ? 0 : sel + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = sel == null ? n - 1 : sel - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (jump) next = (sel ?? 0) + jump;
    if (next == null) return;
    e.preventDefault();
    sel = Math.max(0, Math.min(n - 1, next));
  }

  // one overlay for the pointer: a mouse selects on hover and opens on click; on touch the first tap selects, the second opens
  const at = (e: MouseEvent) => {
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n)));
  };
  let lastType = 'mouse';
  const move = (e: PointerEvent) => { lastType = e.pointerType; if (e.pointerType === 'mouse') sel = at(e); };
  const down = (e: PointerEvent) => { lastType = e.pointerType; };
  function click(e: MouseEvent) {
    const i = at(e);
    if (lastType === 'mouse' || sel === i) onzoom(series[i]);
    else sel = i;
  }
</script>

<div class="wrap" bind:clientWidth={width}>
  <div class="top">
    <p class="readout mono" aria-live="polite">{readout}</p>
    {#if sel != null && series[sel]}
      <button class="zoom" onclick={() => onzoom(series[sel as number])}>{gran === 'day' ? t('openDay') : t('zoomTo')}</button>
    {/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg {width} height={H} viewBox="0 0 {width} {H}" role="group" aria-label="{aria}. {t('chartKeys')} {t('zoomHint')}" tabindex="0" onkeydown={key} onblur={() => (sel = null)}>
    <path d="M{PX} {y(0)}H{width - PX}" stroke="var(--hairline)" stroke-width="2" />
    {#if goal}
      <rect x={PX} y={y(goal.kcal * 1.1)} width={plotW} height={y(goal.kcal * 0.9) - y(goal.kcal * 1.1)} fill="var(--bar)" opacity="0.16" />
      <path d="M{PX} {y(goal.kcal)}H{width - PX}" stroke="var(--text)" stroke-width="2" stroke-dasharray="7 4" />
      <text x={width - PX - 2} y={y(goal.kcal * 1.1) - 5} text-anchor="end" class="lab halo">{t('goalLine', { n: fmt(goal.kcal) })} kcal</text>
    {/if}
    {#each series as s, i (s.start)}
      {#if sel === i}<rect x={cx(i) - step / 2} y={PT - 4} width={step} height={plotH + 4} rx="4" fill="var(--text)" opacity="0.1" />{/if}
      {#if s.logged_days > 0 && s.kcal > 0}
        {@const top = y(s.kcal)}
        {@const upper = upperOf(s)}
        {@const over = s.kcal > upper}
        {@const split = over ? y(upper) : top}
        <path d="M{cx(i)} {y(0)}V{split}" stroke="var(--bar)" stroke-width={bw} stroke-dasharray="4 2" />
        {#if over}<path d="M{cx(i)} {split}V{top}" stroke="var(--bar-over)" stroke-width={bw} stroke-dasharray="4 2" />{/if}
      {:else}
        <circle cx={cx(i)} cy={y(0) - 3} r="1.8" fill="var(--dim)" />
      {/if}
      {#if prevAt(i)}
        {@const p = prevAt(i)!}
        {#if bw >= 5}
          <rect class="prev" x={cx(i) - bw / 2 - 1} y={y(p.kcal)} width={bw + 2} height={Math.max(0, y(0) - y(p.kcal))} rx="2" />
        {:else}
          <path class="prev" d="M{cx(i) - Math.max(bw, 2)} {y(p.kcal)}h{Math.max(bw, 2) * 2}" />
        {/if}
      {/if}
    {/each}
    {#each labels as i (i)}
      <text x={cx(i) + shiftX(i)} y={H - 8} text-anchor={anchor(i)} class="lab">{sectionShort(series[i], gran, multiYear)}</text>
    {/each}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <rect class="hit" x={PX} y="0" width={plotW} height={H} fill="transparent" onpointermove={move} onpointerdown={down}
      onpointerleave={(e) => { if (e.pointerType === 'mouse') sel = null; }} onclick={click} />
  </svg>
  <ul class="facts mono">
    <li><span class="micro quiet">Ø</span>{fmt(avg)}</li>
    <li><span class="micro quiet">min</span>{fmt(lo)}</li>
    <li><span class="micro quiet">max</span>{fmt(hi)}</li>
    {#if previous}
      <li class="key"><svg width="18" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="15" height="9" rx="2" class="prev" /></svg>{t('chartPrev')}</li>
    {/if}
  </ul>
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  svg { display: block; touch-action: pan-y; border-radius: 12px; }
  svg:focus-visible { outline: 3px solid var(--focus-base); outline-offset: 2px; }
  .hit { cursor: pointer; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 34px; }
  .readout { font-size: 13px; font-weight: 500; color: var(--text); min-width: 0; }
  .zoom { flex-shrink: 0; min-height: 34px; padding: 0 14px; border-radius: 17px; background: var(--sel-bg); color: var(--sel-fg); font-size: 13px; font-weight: 600; }
  .lab { font-family: var(--f-mono); font-size: 11px; fill: var(--quiet); }
  .halo { paint-order: stroke; stroke: var(--paper); stroke-width: 4px; stroke-linejoin: round; }
  .prev { fill: none; stroke: var(--quiet); stroke-width: 1.6; opacity: 0.85; }
  .facts { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 13px; font-weight: 600; align-items: center; }
  .facts .micro { margin-right: 5px; }
  .facts .key { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; color: var(--quiet); font-size: 12px; }
</style>
