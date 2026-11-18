<script lang="ts">
  import { daysBetween, fromDay } from '../lib/date';
  import { fmt1, lang, t } from '../lib/i18n';
  import type { Insights } from '../lib/types';

  let { from, to, weight, raw }: { from: string; to: string; weight: NonNullable<Insights['weight']>; raw: { day: string; kg: number }[] } = $props();

  let width = $state(320);
  const H = $derived(width > 480 ? 360 : width > 370 ? 300 : 190);
  // body fat (percent) is a second line on its own right-hand axis, so the kg scale stays untouched
  const fat = $derived(weight.body_fat ?? []);
  const PL = 42, PT = 12, PB = 26;
  const PR = $derived(fat.length ? 42 : 10);
  const span = $derived(Math.max(daysBetween(from, to), 1));
  const lo = $derived(Math.min(...raw.map((p) => p.kg), ...weight.trend.map((p) => p.kg)));
  const hi = $derived(Math.max(...raw.map((p) => p.kg), ...weight.trend.map((p) => p.kg)));
  // pad the scale and snap it to half kilos so the axis labels stay readable
  const vmin = $derived(Math.floor((lo - 0.4) * 2) / 2);
  const vmax = $derived(Math.max(Math.ceil((hi + 0.4) * 2) / 2, vmin + 1));
  const x = (day: string) => (raw.length < 2 && span === 0 ? width / 2 : PL + ((width - PL - PR) * daysBetween(from, day)) / span);
  const y = (kg: number) => PT + (H - PT - PB) * (1 - (kg - vmin) / (vmax - vmin));
  // with years of data single points would only smear: the trend line carries the picture
  const dots = $derived(raw.length <= 150);
  const grid = $derived([vmin, (vmin + vmax) / 2, vmax]);
  const fmin = $derived(fat.length ? Math.floor(Math.min(...fat.map((p) => p.pct)) - 0.5) : 0);
  const fmax = $derived(fat.length ? Math.max(Math.ceil(Math.max(...fat.map((p) => p.pct)) + 0.5), fmin + 2) : 1);
  const yf = (pct: number) => PT + (H - PT - PB) * (1 - (pct - fmin) / (fmax - fmin));
  const fatGrid = $derived([fmin, (fmin + fmax) / 2, fmax]);
  const fatLine = $derived(fat.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)} ${yf(p.pct).toFixed(1)}`).join(''));
  const line = $derived(weight.trend.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)} ${y(p.kg).toFixed(1)}`).join(''));
  const end = $derived(weight.trend[weight.trend.length - 1]);
  const dm = (day: string) => new Intl.DateTimeFormat(lang, span > 366 ? { day: 'numeric', month: 'numeric', year: '2-digit' } : { day: 'numeric', month: 'numeric' }).format(fromDay(day));
  const aria = $derived(t('wtAria', { first: fmt1(weight.first), last: fmt1(weight.last), change: (weight.change > 0 ? '+' : '') + fmt1(weight.change), n: raw.length })
    + (fat.length ? '. ' + t('wtBodyAria', { first: fmt1(fat[0].pct), last: fmt1(fat[fat.length - 1].pct) }) : ''));
</script>

<div bind:clientWidth={width}>
  <svg {width} height={H} viewBox="0 0 {width} {H}" role="img" aria-label={aria}>
    {#each grid as g}
      <path d="M{PL} {y(g)}H{width - PR}" stroke="var(--hairline)" stroke-width="1.5" stroke-dasharray="3 4" />
      <text x={PL - 7} y={y(g) + 4} text-anchor="end" class="lab">{fmt1(g)}</text>
    {/each}
    <path d="M{PL} {H - PB}H{width - PR}" stroke="var(--hairline)" stroke-width="2" />
    {#each dots ? raw : [] as p (p.day)}
      <circle cx={x(p.day)} cy={y(p.kg)} r="3" fill="var(--paper)" stroke="var(--quiet)" stroke-width="1.6" />
    {/each}
    {#if fat.length}
      {#each fatGrid as g}<text x={width - PR + 7} y={yf(g) + 4} text-anchor="start" class="lab fatlab">{fmt1(g)}</text>{/each}
      <path d={fatLine} fill="none" stroke="var(--orange)" stroke-width="2.5" stroke-dasharray="6 4" stroke-linecap="round" stroke-linejoin="round" />
      {#if fat.length < 40}{#each fat as p (p.day)}<circle cx={x(p.day)} cy={yf(p.pct)} r="2.5" fill="var(--orange)" />{/each}{/if}
    {/if}
    <path d={line} fill="none" stroke="var(--bar)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
    {#if end}<circle cx={x(end.day)} cy={y(end.kg)} r="7" fill="var(--orange)" stroke="var(--paper)" stroke-width="3" />{/if}
    <text x={PL} y={H - 7} text-anchor="start" class="lab">{dm(from)}</text>
    <text x={width - PR} y={H - 7} text-anchor="end" class="lab">{dm(to)}</text>
  </svg>
  <p class="legend mono">
    {#if dots}<span><svg width="16" height="10" aria-hidden="true"><circle cx="8" cy="5" r="3" fill="var(--paper)" stroke="var(--quiet)" stroke-width="1.6" /></svg>{t('wtMeasured')}</span>{/if}
    <span><svg width="16" height="10" aria-hidden="true"><path d="M0 5H16" stroke="var(--bar)" stroke-width="3.5" stroke-linecap="round" /></svg>{t('wtTrend')}</span>
    {#if fat.length}<span><svg width="16" height="10" aria-hidden="true"><path d="M0 5H16" stroke="var(--orange)" stroke-width="2.5" stroke-dasharray="4 3" /></svg>{t('wtBodyFat')}</span>{/if}
  </p>
  {#if !dots}<p class="note">{t('wtNoLine')}</p>{/if}
</div>

<style>
  svg { display: block; }
  .lab { font-family: var(--f-mono); font-size: 11px; fill: var(--quiet); }
  .fatlab { fill: var(--orange); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--quiet); margin-top: 6px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
</style>
