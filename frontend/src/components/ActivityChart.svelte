<script lang="ts">
  import { diffDays, labelIndexes } from '../lib/insightsRange';
  import { fmt, t } from '../lib/i18n';
  import { sectionLabel, sectionShort } from '../lib/sections';
  import type { Granularity, Section } from '../lib/types';

  // Steps per section (day, week or month): a bar is the mean per day with a value, the dashed line is the steps goal.
  // Hover, tap or the arrow keys read a section out; a second series (outline) shows the period before.
  let { series, previous = null, goal, gran }:
    { series: Section[]; previous?: Section[] | null; goal: number; gran: Granularity } = $props();

  let width = $state(320);
  const H = $derived(width > 700 ? 230 : 180);
  const PT = 12, PB = 28, PX = 6;
  const plotH = $derived(H - PT - PB);
  const plotW = $derived(Math.max(100, width - PX * 2));
  const n = $derived(series.length);
  const has = (s: Section | undefined | null) => !!s && s.steps != null && s.steps > 0;
  const got = $derived(series.filter(has));
  const maxVal = $derived(Math.max(...series.map((s) => s.steps ?? 0), ...(previous ?? []).map((s) => s.steps ?? 0), goal * 1.15, 100));
  const y = (v: number) => PT + plotH - (v / maxVal) * plotH;
  const step = $derived(plotW / Math.max(n, 1));
  const bw = $derived(Math.max(1.5, Math.min(step * (step < 14 ? 0.62 : 0.7), 30)));
  const cx = (i: number) => PX + step * (i + 0.5);
  const multiYear = $derived(n > 0 && diffDays(series[0].start, series[n - 1].end) > 366);
  const labels = $derived(labelIndexes(n, width < 500 ? 4 : width < 800 ? 6 : width < 1100 ? 8 : 11));
  const edge = $derived(step < 36);
  const anchor = (i: number) => (labels.length < 2 || !edge ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
  const shiftX = (i: number) => (labels.length < 2 || !edge ? 0 : i === 0 ? -step / 2 + 1 : i === n - 1 ? step / 2 - 1 : 0);

  let sel = $state<number | null>(null);
  $effect(() => { series; sel = null; });
  const readout = $derived.by(() => {
    if (sel == null || !series[sel]) return t('chartTap');
    const s = series[sel];
    const label = sectionLabel(s, gran);
    if (!has(s)) return t('insActReadoutNone', { label });
    return t('insActReadout', { label, steps: fmt(s.steps ?? 0), active: fmt(s.active_kcal ?? 0), minutes: fmt(Math.round(s.workout_minutes)) });
  });

  const avg = $derived(got.length ? Math.round(got.reduce((s, b) => s + (b.steps ?? 0), 0) / got.length) : 0);
  const aria = $derived(t('insActAria', { avg: fmt(avg), goal: fmt(goal) }));

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
  const at = (e: MouseEvent) => {
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) / box.width) * n)));
  };
  const move = (e: PointerEvent) => { if (e.pointerType === 'mouse') sel = at(e); };
</script>

<div class="wrap" bind:clientWidth={width}>
  <p class="readout mono" aria-live="polite">{readout}</p>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg {width} height={H} viewBox="0 0 {width} {H}" role="group" aria-label="{aria}. {t('chartKeys')}" tabindex="0" onkeydown={key} onblur={() => (sel = null)}>
    <path d="M{PX} {y(0)}H{width - PX}" stroke="var(--hairline)" stroke-width="2" />
    <path d="M{PX} {y(goal)}H{width - PX}" stroke="var(--text)" stroke-width="2" stroke-dasharray="7 4" />
    {#each series as s, i (s.start)}
      {#if sel === i}<rect x={cx(i) - step / 2} y={PT - 4} width={step} height={plotH + 4} rx="4" fill="var(--text)" opacity="0.1" />{/if}
      {#if has(s)}
        <path d="M{cx(i)} {y(0)}V{y(s.steps as number)}" stroke="var(--bar)" stroke-width={bw} stroke-dasharray="4 2" />
      {:else}
        <circle cx={cx(i)} cy={y(0) - 3} r="1.8" fill="var(--dim)" />
      {/if}
      {#if previous && has(previous[i])}
        {@const p = previous[i]}
        {#if bw >= 5}
          <rect class="prev" x={cx(i) - bw / 2 - 1} y={y(p.steps as number)} width={bw + 2} height={Math.max(0, y(0) - y(p.steps as number))} rx="2" />
        {:else}
          <path class="prev" d="M{cx(i) - Math.max(bw, 2)} {y(p.steps as number)}h{Math.max(bw, 2) * 2}" />
        {/if}
      {/if}
    {/each}
    <text x={width - PX - 2} y={y(goal) - 5} text-anchor="end" class="lab halo">{t('insActGoalLine', { n: fmt(goal) })}</text>
    {#each labels as i (i)}
      <text x={cx(i) + shiftX(i)} y={H - 8} text-anchor={anchor(i)} class="lab">{sectionShort(series[i], gran, multiYear)}</text>
    {/each}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <rect x={PX} y="0" width={plotW} height={H} fill="transparent" onpointermove={move} onpointerdown={(e) => { sel = at(e); }}
      onpointerleave={(e) => { if (e.pointerType === 'mouse') sel = null; }} />
  </svg>
  {#if previous}
    <p class="key mono"><svg width="18" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="15" height="9" rx="2" class="prev" /></svg>{t('chartPrev')}</p>
  {/if}
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  svg { display: block; touch-action: pan-y; border-radius: 12px; }
  svg:focus-visible { outline: 3px solid var(--focus-base); outline-offset: 2px; }
  .readout { font-size: 13px; font-weight: 500; color: var(--text); min-height: 34px; display: flex; align-items: center; }
  .lab { font-family: var(--f-mono); font-size: 11px; fill: var(--quiet); }
  .halo { paint-order: stroke; stroke: var(--paper); stroke-width: 4px; stroke-linejoin: round; }
  .prev { fill: none; stroke: var(--quiet); stroke-width: 1.6; opacity: 0.85; }
  .key { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; color: var(--quiet); font-size: 12px; }
</style>
