<script lang="ts">
  import { fmt, lang, t } from '../lib/i18n';
  import { dayLabel, monthLongOf } from '../lib/sections';
  import { dayOfMonth } from '../lib/date';
  import { ui } from '../lib/store.svelte';
  import { arrowDay, calendarMode, monthBlocks, tally, weekColumns, type CalState, type GridCell } from '../lib/calendarGrid';
  import type { InsightDay } from '../lib/types';

  // Calendar of the evaluation. Up to eight weeks a month calendar (weeks as rows, Monday first like everywhere in the app),
  // beyond that one column per week across the card (scrolls sideways on a phone, starting at the newest week).
  // A state is never colour alone: solid + tick = within the range, hatched + arrow down = below, outlined pink + arrow up = above,
  // dashed = nothing logged, grey + dot = logged without a goal. Details of the day under the pointer / focus / last tap are written out.
  let { cal, days, onopen }: { cal: { day: string; state: CalState }[]; days: InsightDay[]; onopen: (day: string) => void } = $props();

  const STATES: CalState[] = ['in_range', 'under', 'over', 'none', 'no_goal'];
  const stateText = (s: CalState) => t(({ none: 'calNone', under: 'calUnder', in_range: 'calIn', over: 'calOver', no_goal: 'calNoGoal' } as const)[s]);

  const sorted = $derived([...cal].sort((a, b) => (a.day < b.day ? -1 : 1)));
  const first = $derived(sorted[0]?.day ?? '');
  const last = $derived(sorted[sorted.length - 1]?.day ?? '');
  const mode = $derived(calendarMode(cal.length));
  const counts = $derived(tally(cal));
  const blocks = $derived(mode === 'months' ? monthBlocks(cal) : []);
  const grid = $derived(mode === 'weeks' ? weekColumns(cal) : null);
  const byDay = $derived(new Map(days.map((d) => [d.day, d])));
  const stateOf = $derived(new Map(cal.map((d) => [d.day, d.state] as const)));

  const weekdayNames = $derived(Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(new Date(2025, 0, 6 + i, 12)).replace('.', '').slice(0, 2)));
  const monthShort = $derived(new Intl.DateTimeFormat(lang, { month: 'short' }));
  const shortMonth = (month: string) => monthShort.format(new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1, 12)).replace('.', '');

  let sel = $state<string | null>(null);
  let hover = $state<string | null>(null);
  const shown = $derived(hover ?? sel);
  const focusDay = $derived(sel && stateOf.has(sel) ? sel : last); // the one square in the tab order

  const kcalOf = (day: string) => (stateOf.get(day) === 'none' ? null : (byDay.get(day)?.kcal ?? null));
  const goalOf = (day: string) => byDay.get(day)?.goal_kcal ?? null;
  const kcalText = (day: string) => {
    const k = kcalOf(day), g = goalOf(day);
    if (k == null) return '';
    return g != null && stateOf.get(day) !== 'no_goal' ? t('calGoalKcal', { kcal: fmt(Math.round(k)), goal: fmt(Math.round(g)) }) : t('calKcalOnly', { kcal: fmt(Math.round(k)) });
  };
  const label = (day: string) => [dayLabel(day), day === ui.today ? t('calToday') : '', kcalText(day), stateText(stateOf.get(day) ?? 'none')].filter(Boolean).join(', ');
  const aria = $derived(t('calAria', { n: counts.total, list: STATES.filter((s) => counts[s]).map((s) => `${counts[s]} ${stateText(s)}`).join(', ') }));

  // pointer: a mouse opens the day on click; a finger first selects (details below), the second tap on it opens
  let pointerKind = 'mouse';
  let armed = false;
  const down = (e: PointerEvent, day: string) => { pointerKind = e.pointerType; armed = sel === day; };
  function click(e: MouseEvent, day: string) {
    if (e.detail === 0 || pointerKind === 'mouse' || armed) onopen(day);
    else sel = day;
    armed = false;
  }
  const enter = (e: PointerEvent, day: string) => { if (e.pointerType === 'mouse') hover = day; };
  const leave = (e: PointerEvent) => { if (e.pointerType === 'mouse') hover = null; };

  let root: HTMLDivElement | undefined = $state();
  function key(e: KeyboardEvent) {
    const from = (e.target as HTMLElement).closest<HTMLElement>('[data-day]')?.dataset.day;
    if (!from || !first) return;
    const to = arrowDay(e.key, mode === 'weeks', from, first, last);
    if (to == null) return;
    e.preventDefault();
    sel = to;
    hover = null;
    root?.querySelector<HTMLElement>(`[data-day="${to}"]`)?.focus();
  }

  // compact view: square size from the width, the newest week in view
  let avail = $state(320);
  const LW = 30, GAP = 3, MIN = 16, MAX = 72;
  const cols = $derived(grid?.weeks.length ?? 0);
  const cw = $derived(Math.max(MIN, Math.min(MAX, Math.floor((avail - LW - GAP * Math.max(cols - 1, 0)) / Math.max(cols, 1)))));
  const ch = $derived(Math.min(46, Math.round(cw * 1.15)));
  const LABEL_H = 20;
  const X = (c: number) => LW + c * (cw + GAP) - GAP / 2;
  const Y = (r: number) => LABEL_H + r * (ch + GAP) - GAP / 2;
  const stepPath = (s: { col: number; row: number }) => (s.row === 0 ? `M${X(s.col)} ${Y(0)}V${Y(7)}` : `M${X(s.col)} ${Y(7)}V${Y(s.row)}H${X(s.col + 1)}V${Y(0)}`);
  let scroller: HTMLDivElement | undefined = $state();
  $effect(() => { cols; cw; if (scroller) scroller.scrollLeft = scroller.scrollWidth; });
</script>

{#snippet mark(s: CalState, size: number)}
  <svg class="mk" width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
    {#if s === 'in_range'}
      <rect x="1" y="1" width="16" height="16" rx="6" ry="6" fill="var(--bar)" />
      <path d="M5.2 9.6l2.7 2.6 5-5.4" fill="none" stroke="var(--in-fg)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    {:else if s === 'under'}
      <rect x="1" y="1" width="16" height="16" rx="6" ry="6" fill="url(#cal-hatch)" stroke="var(--bar-soft)" stroke-width="1.6" />
      <path d="M9 5v7.2M5.8 9.4L9 12.6l3.2-3.2" fill="none" stroke="var(--text)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
    {:else if s === 'over'}
      <rect x="1.2" y="1.2" width="15.6" height="15.6" rx="6" ry="6" fill="var(--over-fill)" stroke="var(--bar-over)" stroke-width="2.4" />
      <path d="M9 12.6V5.4M5.8 8.2L9 5l3.2 3.2" fill="none" stroke="var(--text)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
    {:else if s === 'no_goal'}
      <circle cx="9" cy="9" r="7.6" fill="var(--track)" stroke="var(--dim)" stroke-width="1.6" />
      <circle cx="9" cy="9" r="2.2" fill="var(--text)" />
    {:else}
      <rect x="1.2" y="1.2" width="15.6" height="15.6" rx="6" ry="6" fill="none" stroke="var(--dim)" stroke-width="1.6" stroke-dasharray="3 2.6" />
    {/if}
  </svg>
{/snippet}

{#snippet square(c: GridCell, style: string, wide: boolean)}
  {#if c.inPeriod}
    {@const k = kcalOf(c.day)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <button type="button" class="d {c.state}" class:on={shown === c.day} class:today={c.day === ui.today} {style} data-day={c.day}
      tabindex={c.day === focusDay ? 0 : -1} aria-label={label(c.day)}
      onpointerdown={(e) => down(e, c.day)} onclick={(e) => click(e, c.day)} onfocus={() => { sel = c.day; }}
      onpointerenter={(e) => enter(e, c.day)} onpointerleave={leave}>
      {#if wide}
        <span class="n">{dayOfMonth(c.day)}</span>
        <span class="g">{@render mark(c.state, 14)}</span>
        {#if k != null}<span class="k">{fmt(Math.round(k))}</span>{/if}
      {:else if cw >= 30}<span class="n small">{dayOfMonth(c.day)}</span>{/if}
    </button>
  {:else}
    <span class="d out" {style}><span class="n">{wide ? dayOfMonth(c.day) : ''}</span></span>
  {/if}
{/snippet}

<div class="calq">
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="cal" bind:this={root} role="group" aria-label={aria} aria-describedby="cal-keys" onkeydown={key}>
  <svg width="0" height="0" class="defs" aria-hidden="true">
    <defs>
      <pattern id="cal-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="5" height="5" fill="var(--stone)" /><rect width="2" height="5" fill="var(--bar-soft)" />
      </pattern>
    </defs>
  </svg>
  <span id="cal-keys" class="sr-only">{t('calKeys')}</span>

  <ul class="sum" aria-label={t('calSummary')}>
    {#each STATES as s}
      {#if s !== 'no_goal' || counts.no_goal}
        <li>{@render mark(s, 22)}<b class="num">{counts[s]}</b><span>{stateText(s)}</span></li>
      {/if}
    {/each}
  </ul>
  <div class="detail" aria-live="polite">
    {#if shown && stateOf.has(shown)}
      {@const st = stateOf.get(shown) as CalState}
      <div class="dtx">
        <p class="dt"><b>{dayLabel(shown)}</b>{#if shown === ui.today}<span class="tag">{t('calToday')}</span>{/if}</p>
        <p class="ds">{@render mark(st, 16)}<span>{stateText(st)}</span>{#if kcalText(shown)}<span class="dk mono">{kcalText(shown)}</span>{/if}</p>
      </div>
      {#if sel && sel === shown}<button type="button" class="zoom" onclick={() => onopen(sel as string)}>{t('calOpen')}</button>{/if}
    {:else}<p class="hint">{t('calHint')}</p>{/if}
  </div>

  {#if mode === 'months'}
    <div class="blocks area-main">
      {#each blocks as b (b.month)}
        <section class="month" aria-label={monthLongOf(b.month)}>
          <h4 class="mh display">{monthLongOf(b.month)}</h4>
          <div class="mgrid">
            {#each weekdayNames as w}<span class="wd mono" aria-hidden="true">{w}</span>{/each}
            {#each b.weeks as row}
              {#each row as c, i}
                {#if c}{@render square(c, '', true)}{:else}<span class="blank"></span>{/if}
              {/each}
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {:else if grid}
    <div class="scroll area-main" bind:this={scroller} bind:clientWidth={avail}>
      <div class="wk" style="width:{LW + cols * (cw + GAP) - GAP}px; height:{LABEL_H + 7 * (ch + GAP) - GAP}px; --cw:{cw}px; --ch:{ch}px; --gap:{GAP}px">
        {#each grid.marks as m (m.month)}
          <span class="ml mono" style="left:{LW + m.col * (cw + GAP)}px">{shortMonth(m.month)}{#if m.yearChanged || m === grid.marks[0]}<i> ’{m.month.slice(2, 4)}</i>{/if}</span>
        {/each}
        {#each [0, 2, 4] as r}<span class="wl mono" style="top:{LABEL_H + r * (ch + GAP)}px;height:{ch}px" aria-hidden="true">{weekdayNames[r]}</span>{/each}
        {#each grid.weeks as week, c}
          {#each week as cell, r}
            {#if cell}{@render square(cell, `left:${LW + c * (cw + GAP)}px;top:${LABEL_H + r * (ch + GAP)}px;width:${cw}px;height:${ch}px`, false)}{/if}
          {/each}
        {/each}
        <svg class="steps" width={LW + cols * (cw + GAP)} height={LABEL_H + 7 * (ch + GAP)} aria-hidden="true">
          {#each grid.starts as s}<path d={stepPath(s)} fill="none" />{/each}
        </svg>
      </div>
    </div>
  {/if}
</div>
</div>

<style>
  .cal {
    --in-fg: #fff;
    --over-fill: color-mix(in srgb, var(--bar-over) 28%, var(--paper));
    min-width: 0;
  }
  :global(:root[data-theme='dark']) .cal { --in-fg: #0f1512; }
  .calq { container: cal / inline-size; min-width: 0; }
  .defs { position: absolute; }
  .mk { display: block; flex-shrink: 0; }

  /* summary doubles as the legend; the day details stay in view while a phone scrolls */
  .cal { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .sum { display: grid; grid-template-columns: repeat(auto-fit, minmax(64px, 1fr)); gap: 6px; }
  .sum li { display: grid; grid-template-columns: auto 1fr; grid-template-areas: 'm n' 'l l'; align-items: center; column-gap: 7px; padding: 9px 10px; background: var(--stone); border-radius: 16px 16px 16px 6px; font-size: 11.5px; color: var(--quiet); min-width: 0; }
  .sum li :global(.mk) { grid-area: m; }
  .sum .num { grid-area: n; font-family: var(--f-display); font-weight: 800; font-size: 24px; line-height: 1; letter-spacing: -0.03em; color: var(--text); }
  .sum li span { grid-area: l; margin-top: 4px; line-height: 1.2; overflow-wrap: anywhere; hyphens: auto; }
  .detail { position: sticky; top: calc(8px + var(--band, 0px)); z-index: 5; min-height: 62px; background: var(--stone); border-radius: 16px 16px 16px 6px; padding: 10px 14px; display: flex; gap: 10px; justify-content: space-between; align-items: center; box-shadow: 0 0 0 2px var(--paper), 0 6px 14px -8px rgb(0 0 0 / 0.35); }
  .dtx { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .dt { font-size: 15px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .dt b { font-weight: 600; }
  .tag { font-family: var(--f-mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; background: var(--lime); color: var(--on-lime); border-radius: 8px 8px 8px 3px; padding: 2px 7px; }
  .ds { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; font-size: 13.5px; color: var(--quiet); }
  .dk { font-size: 13.5px; font-weight: 500; color: var(--text); }
  .hint { font-size: 13px; color: var(--quiet); }
  .zoom { flex-shrink: 0; min-height: 38px; padding: 0 16px; border-radius: 19px 19px 19px 6px; background: var(--sel-bg); color: var(--sel-fg); font-size: 13px; font-weight: 600; }

  /* squares */
  .d { display: block; position: relative; border: 0; padding: 0; font: inherit; color: var(--text); text-align: left; -webkit-tap-highlight-color: transparent; }
  button.d { cursor: pointer; }
  button.d:focus-visible { outline: 3px solid var(--focus-base); outline-offset: 2px; z-index: 2; }
  .d.in_range { background: var(--bar); color: var(--in-fg); }
  .d.under { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--bar-soft) 60%, transparent) 0 1.5px, transparent 1.5px 6px), var(--stone); box-shadow: inset 0 0 0 1.5px var(--bar-soft); }
  .d.over { background: var(--over-fill); box-shadow: inset 0 0 0 2.5px var(--bar-over); }
  .d.none { box-shadow: inset 0 0 0 1.5px var(--dim); color: var(--quiet); background: transparent; clip-path: none; }
  .d.no_goal { background: var(--track); box-shadow: inset 0 0 0 1.5px var(--dim); }
  .d.on { z-index: 1; box-shadow: 0 0 0 2px var(--paper), 0 0 0 4px var(--text); }
  .d.out { color: var(--dim); opacity: 0.75; }

  /* month view */
  .blocks { display: flex; flex-wrap: wrap; gap: 22px 32px; min-width: 0; }
  .month { flex: 1 1 320px; max-width: 540px; min-width: 0; container: month / inline-size; }
  .mh { font-size: 22px; line-height: 1.1; margin-bottom: 8px; }
  .mgrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
  .wd { text-align: center; font-size: 10.5px; color: var(--quiet); text-transform: uppercase; letter-spacing: 0.06em; padding-bottom: 2px; }
  .mgrid .d { height: 58px; border-radius: 14px 14px 14px 5px; padding: 6px 7px; display: flex; flex-direction: column; justify-content: space-between; transition: transform 0.12s; }
  .blank { min-height: 0; }
  .mgrid .n { font-family: var(--f-display); font-weight: 800; font-size: 17px; line-height: 1; letter-spacing: -0.03em; align-self: flex-start; }
  .mgrid .g { position: absolute; top: 5px; right: 5px; }
  .mgrid .k { font-family: var(--f-mono); font-size: 11.5px; font-weight: 500; line-height: 1; }
  .mgrid .d.today .n { background: var(--lime); color: var(--on-lime); border-radius: 9px 9px 9px 3px; padding: 3px 6px; margin: -3px 0 0 -4px; }
  .mgrid .d.out .n { font-weight: 600; font-size: 15px; }
  @container month (min-width: 440px) { .mgrid .d { height: 68px; } .mgrid .n { font-size: 19px; } .mgrid .k { font-size: 12.5px; } }
  @container month (max-width: 340px) {
    .mgrid .n { font-size: 14px; }
    .mgrid .g { display: none; }
    .mgrid .k { font-size: 9.5px; }
    .mgrid .d { padding: 5px 4px; height: 52px; border-radius: 11px 11px 11px 4px; }
    .mgrid .d.today .n { padding: 2px 4px; margin: -2px 0 0 -3px; }
  }
  @container month (max-width: 280px) { .mgrid .k { display: none; } }

  /* compact view */
  .scroll { overflow-x: auto; overflow-y: hidden; padding: 4px 4px 8px; margin: -4px -4px 0; min-width: 0; }
  .wk { position: relative; }
  .wk .d { position: absolute; border-radius: 6px 6px 6px 2px; display: grid; place-items: center; }
  .wk .n.small { font-family: var(--f-display); font-weight: 800; font-size: 12px; line-height: 1; }
  .wk .d.today::after { content: ''; position: absolute; top: -3px; right: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--lime); box-shadow: 0 0 0 1.5px var(--text); }
  .ml { position: absolute; top: 0; font-size: 11px; color: var(--text); white-space: nowrap; letter-spacing: 0.02em; }
  .ml i { font-style: normal; color: var(--quiet); }
  .wl { position: absolute; left: 0; display: flex; align-items: center; font-size: 10.5px; color: var(--quiet); }
  .steps { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
  .steps path { stroke: var(--text); stroke-width: 1.3; opacity: 0.45; stroke-linejoin: round; }

  /* wide card: summary and details beside the month grids, or side by side above the week columns */
  @container cal (min-width: 820px) {
    .cal:has(.blocks) { grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: auto auto 1fr; column-gap: 32px; }
    .cal:has(.blocks) .sum { grid-column: 2; grid-row: 1; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .cal:has(.blocks) .detail { grid-column: 2; grid-row: 2; align-self: start; top: 16px; }
    .cal:has(.blocks) .area-main { grid-column: 1; grid-row: 1 / span 3; }
    .cal:not(:has(.blocks)) { grid-template-columns: minmax(0, 1fr) 340px; }
    .cal:not(:has(.blocks)) .area-main { grid-column: 1 / -1; grid-row: 2; }
    .sum li { padding: 12px 14px; font-size: 12.5px; }
    .sum .num { font-size: 28px; }
  }
  @media (prefers-reduced-motion: reduce) { .mgrid .d { transition: none; } }
</style>
