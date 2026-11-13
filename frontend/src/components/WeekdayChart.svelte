<script lang="ts">
  import { fmt, lang, t } from '../lib/i18n';
  import type { Goal, Insights } from '../lib/types';

  let { data, goal }: { data: Insights['by_weekday']; goal: Goal | null } = $props();

  // 2025-01-06 is a Monday
  const names = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(new Date(2025, 0, 6 + i, 12)).replace('.', '').slice(0, 2));
  const longNames = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(lang, { weekday: 'long' }).format(new Date(2025, 0, 6 + i, 12)));

  let width = $state(320);
  const H = $derived(width > 380 ? 232 : 176);
  const PT = 30, PB = 24;
  const maxVal = $derived(Math.max(...data.map((d) => d.kcal), goal ? goal.kcal * 1.1 : 0, 100));
  const y = (v: number) => PT + (H - PT - PB) * (1 - v / maxVal);
  const step = $derived(width / 7);
  const bw = $derived(Math.min(step * 0.58, 34));
  const aria = $derived(t('weekdaysAria', { list: data.map((d, i) => `${longNames[i]} ${d.logged_days ? fmt(Math.round(d.kcal)) : '–'}`).join(', ') }));
</script>

<div bind:clientWidth={width}>
  <svg {width} height={H} viewBox="0 0 {width} {H}" role="img" aria-label={aria}>
    <path d="M0 {y(0)}H{width}" stroke="var(--hairline)" stroke-width="2" />
    {#if goal}<path d="M0 {y(goal.kcal)}H{width}" stroke="var(--text)" stroke-width="2" stroke-dasharray="7 4" />{/if}
    {#each data as d, i (d.weekday)}
      {@const cx = step * (i + 0.5)}
      {#if d.logged_days > 0}
        <path d="M{cx} {y(0)}V{y(d.kcal)}" stroke={i >= 5 ? 'var(--series-dark)' : 'var(--bar)'} stroke-width={bw} stroke-dasharray="4 2" />
      {/if}
      <text x={cx} y="12" text-anchor="middle" class="val">{d.logged_days > 0 ? fmt(Math.round(d.kcal)) : '–'}</text>
      <text x={cx} y={H - 6} text-anchor="middle" class="lab" class:we={i >= 5}>{names[i]}</text>
    {/each}
  </svg>
</div>

<style>
  svg { display: block; }
  .lab { font-family: var(--f-mono); font-size: 12px; fill: var(--quiet); font-weight: 500; }
  .lab.we { fill: var(--text); font-weight: 600; }
  .val { font-family: var(--f-mono); font-size: 11px; fill: var(--text); font-weight: 600; }
</style>
