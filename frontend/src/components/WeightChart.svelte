<script lang="ts">
  import { daysBetween, fromDay } from '../lib/date';
  import { fmt1, lang, t } from '../lib/i18n';
  import type { Insights } from '../lib/types';
  import { provisional, trendOf, usualSpread } from '../lib/weightTrend';

  // `today`: the trend's last days are drawn faint while values of the coming days can still move them
  // `spread`: the usual spread when the caller already knows it (the weight page reads it from all its values)
  let { from, to, today, weight, raw, spread: given }: { from: string; to: string; today: string; spread?: number | null; weight: Pick<NonNullable<Insights['weight']>, 'first' | 'last' | 'change' | 'trend' | 'body_fat' | 'body_fat_trend'>; raw: { day: string; kg: number }[] } = $props();

  let width = $state(320);
  const H = $derived(width > 480 ? 360 : width > 370 ? 300 : 190);
  // body fat (percent) is a second line on its own right-hand axis, so the kg scale stays untouched: the smoothed line
  // carries the picture, the measured values are only dots (an older server without a trend draws the raw values as the line)
  const fat = $derived(weight.body_fat ?? []);
  const fatTrend = $derived(weight.body_fat_trend?.length ? weight.body_fat_trend : fat);
  const PL = 42, PT = 12, PB = 26;
  const PR = $derived(fat.length ? 42 : 10);
  const span = $derived(Math.max(daysBetween(from, to), 1));
  // the usual day-to-day spread around the trend, as a band: a value inside it is an ordinary day
  const spread = $derived(given !== undefined ? given : raw.length ? usualSpread(raw, trendOf(raw), today) : null);
  const sp = $derived(spread ?? 0);
  const lo = $derived(Math.min(...raw.map((p) => p.kg), ...weight.trend.map((p) => p.kg - sp)));
  const hi = $derived(Math.max(...raw.map((p) => p.kg), ...weight.trend.map((p) => p.kg + sp)));
  // pad the scale and snap it to half kilos so the axis labels stay readable
  const vmin = $derived(Math.floor((lo - 0.4) * 2) / 2);
  const vmax = $derived(Math.max(Math.ceil((hi + 0.4) * 2) / 2, vmin + 1));
  const x = (day: string) => (raw.length < 2 && span === 0 ? width / 2 : PL + ((width - PL - PR) * daysBetween(from, day)) / span);
  const y = (kg: number) => PT + (H - PT - PB) * (1 - (kg - vmin) / (vmax - vmin));
  // with years of data single points would only smear: the trend line carries the picture
  const dots = $derived(raw.length <= 150);
  const grid = $derived([vmin, (vmin + vmax) / 2, vmax]);
  const fmin = $derived(fat.length ? Math.floor(Math.min(...fat.map((p) => p.pct), ...fatTrend.map((p) => p.pct)) - 0.5) : 0);
  const fmax = $derived(fat.length ? Math.max(Math.ceil(Math.max(...fat.map((p) => p.pct), ...fatTrend.map((p) => p.pct)) + 0.5), fmin + 2) : 1);
  const yf = (pct: number) => PT + (H - PT - PB) * (1 - (pct - fmin) / (fmax - fmin));
  const fatGrid = $derived([fmin, (fmin + fmax) / 2, fmax]);
  const fatLine = $derived(fatTrend.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)} ${yf(p.pct).toFixed(1)}`).join(''));
  const path = (pts: { day: string; kg: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)} ${y(p.kg).toFixed(1)}`).join('');
  // the settled part and the open end, joined at the last settled point
  const openAt = $derived.by(() => { const i = weight.trend.findIndex((p) => provisional(p.day, today)); return i < 0 ? weight.trend.length : i; });
  const line = $derived(path(weight.trend.slice(0, openAt)));
  const openLine = $derived(openAt < weight.trend.length ? path(weight.trend.slice(Math.max(0, openAt - 1))) : '');
  const band = $derived(spread === null || !weight.trend.length ? ''
    : path(weight.trend.map((p) => ({ day: p.day, kg: p.kg + spread }))) + [...weight.trend].reverse().map((p) => `L${x(p.day).toFixed(1)} ${y(p.kg - spread).toFixed(1)}`).join('') + 'Z');
  const end = $derived(weight.trend[weight.trend.length - 1]);
  const endOpen = $derived(!!end && provisional(end.day, today));
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
    {#if band}<path d={band} fill="var(--bar)" opacity="0.13" />{/if}
    {#each dots ? raw : [] as p (p.day)}
      <circle cx={x(p.day)} cy={y(p.kg)} r="3" fill="var(--paper)" stroke="var(--quiet)" stroke-width="1.6" />
    {/each}
    {#if fat.length}
      {#each fatGrid as g}<text x={width - PR + 7} y={yf(g) + 4} text-anchor="start" class="lab fatlab">{fmt1(g)}</text>{/each}
      <path d={fatLine} fill="none" stroke="var(--weight-orange)" stroke-width="2.5" stroke-dasharray="6 4" stroke-linecap="round" stroke-linejoin="round" />
      {#if dots}{#each fat as p (p.day)}<circle cx={x(p.day)} cy={yf(p.pct)} r="2.5" fill="var(--paper)" stroke="var(--weight-orange)" stroke-width="1.5" />{/each}{/if}
    {/if}
    {#if line}<path d={line} fill="none" stroke="var(--bar)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />{/if}
    {#if openLine}<path d={openLine} fill="none" stroke="var(--bar)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.35" />{/if}
    {#if end}<circle cx={x(end.day)} cy={y(end.kg)} r="7" fill="var(--weight-orange)" stroke="var(--paper)" stroke-width="3" opacity={endOpen ? 0.6 : 1} />{/if}
    <text x={PL} y={H - 7} text-anchor="start" class="lab">{dm(from)}</text>
    <text x={width - PR} y={H - 7} text-anchor="end" class="lab">{dm(to)}</text>
  </svg>
  <p class="legend mono">
    {#if dots}<span><svg width="16" height="10" aria-hidden="true"><circle cx="8" cy="5" r="3" fill="var(--paper)" stroke="var(--quiet)" stroke-width="1.6" /></svg>{t('wtMeasured')}</span>{/if}
    <span><svg width="16" height="10" aria-hidden="true"><path d="M0 5H16" stroke="var(--bar)" stroke-width="3.5" stroke-linecap="round" /></svg>{t('wtTrend')}</span>
    {#if openLine}<span><svg width="16" height="10" aria-hidden="true"><path d="M0 5H16" stroke="var(--bar)" stroke-width="3.5" stroke-linecap="round" opacity="0.35" /></svg>{t('wtOpen')}</span>{/if}
    {#if band}<span><svg width="16" height="10" aria-hidden="true"><rect width="16" height="10" rx="2" fill="var(--bar)" opacity="0.18" /></svg>{t('wtSpread')} ±{fmt1(spread ?? 0)} {t('kg')}</span>{/if}
    {#if fat.length}<span><svg width="16" height="10" aria-hidden="true"><path d="M0 5H16" stroke="var(--weight-orange)" stroke-width="2.5" stroke-dasharray="4 3" /></svg>{t('wtBodyFat')}</span>{/if}
  </p>
  {#if !dots}<p class="note">{t('wtNoLine')}</p>{/if}
</div>

<style>
  svg { display: block; }
  .lab { font-family: var(--f-mono); font-size: 11px; fill: var(--quiet); }
  .fatlab { fill: var(--weight-orange); }
  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--quiet); margin-top: 6px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
</style>
