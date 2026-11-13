<script lang="ts">
  import { fmt, lang, t } from '../lib/i18n';
  import { amountLabel } from '../lib/portion';
  import { dayLabel, monthLongOf, monthOf } from '../lib/sections';
  import type { FoodDetail } from '../lib/types';
  import MiniBars from './MiniBars.svelte';
  import TickBar from './TickBar.svelte';

  // History of one food in the period: per month, over the meals and weekdays, the usual amounts.
  let { detail, onadd, bare = false }: { detail: FoodDetail; onadd: (() => void) | null; bare?: boolean } = $props();

  const wd = $derived(Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(new Date(2025, 0, 6 + i, 12)).replace('.', '').slice(0, 2)));
  const wdLong = $derived(Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(lang, { weekday: 'long' }).format(new Date(2025, 0, 6 + i, 12))));
  const months = $derived(detail.monthly);
  const monthReadouts = $derived(months.map((m) => t('foodMonthBar', { month: monthLongOf(m.month), times: m.times, kcal: fmt(Math.round(m.kcal)) }) + ` · ${amountLabel(detail, m.amount)}`));
  const meals = $derived(detail.by_meal);
  const topMeal = $derived(Math.max(...meals.map((m) => m.share), 0.0001));
</script>

<div class="fd">
  <header>
    {#if !bare}<h3>{detail.name}</h3>{/if}
    {#if detail.brand}<p class="note">{detail.brand}</p>{/if}
    <p class="facts mono">{t('foodOnDays', { times: detail.times, days: detail.days })} · {fmt(Math.round(detail.kcal_total))} kcal · {amountLabel(detail, detail.amount_total)}</p>
    <p class="note">{t('foodFirstLast', { a: dayLabel(detail.first_day), b: dayLabel(detail.last_day) })}</p>
  </header>

  <section>
    <h4 class="micro quiet">{t('foodMonthly')}</h4>
    <MiniBars values={months.map((m) => m.times)} labels={months.map((m) => monthOf(m.month))} readouts={monthReadouts}
      aria={`${t('foodMonthly')}: ${detail.name}`} wantLabels={4} />
  </section>

  <section>
    <h4 class="micro quiet">{t('foodMeals')}</h4>
    <ul class="meals">
      {#each meals as m (m.meal)}
        <li>
          <span class="nm">{t(m.meal)}</span>
          <TickBar value={m.share} goal={topMeal} track="var(--track)" fill="var(--bar)" label="" height={8} />
          <span class="mono v">{t('foodTimes', { n: m.times })}</span>
        </li>
      {/each}
    </ul>
  </section>

  <section>
    <h4 class="micro quiet">{t('foodWeekdays')}</h4>
    <MiniBars values={detail.by_weekday.map((d) => d.times)} labels={wd} readouts={detail.by_weekday.map((d) => `${wdLong[d.weekday]}: ${t('foodTimes', { n: d.times })}`)}
      aria={`${t('foodWeekdays')}: ${detail.name}`} height={96} wantLabels={7} />
  </section>

  <section>
    <h4 class="micro quiet">{t('foodUsual')}</h4>
    <ul class="usual">
      {#each detail.usual_amounts as u (u.amount)}
        <li class="mono"><b>{amountLabel(detail, u.amount, u.amount % 1 ? 1 : 0)}</b> <span>{t('foodTimes', { n: u.times })}</span></li>
      {/each}
    </ul>
  </section>

  {#if onadd}
    <button class="btn primary add" onclick={onadd}>{t('foodAdd')}</button>
  {:else}
    <p class="note">{t('foodGone')}</p>
  {/if}
</div>

<style>
  .fd { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
  h3 { font-family: var(--f-display); font-weight: 800; font-size: 24px; letter-spacing: -0.03em; line-height: 1.1; overflow-wrap: anywhere; }
  .facts { font-size: 13px; font-weight: 600; margin-top: 4px; }
  section { display: flex; flex-direction: column; gap: 6px; }
  .meals { display: flex; flex-direction: column; gap: 8px; }
  .meals li { display: grid; grid-template-columns: 92px minmax(0, 1fr) 40px; align-items: center; gap: 10px; font-size: 14px; }
  .nm { font-weight: 600; }
  .v { font-size: 13px; font-weight: 600; text-align: right; }
  .usual { display: flex; flex-wrap: wrap; gap: 6px; }
  .usual li { background: color-mix(in srgb, var(--text) 7%, transparent); border-radius: 14px 14px 14px 5px; padding: 7px 12px; font-size: 13px; display: inline-flex; gap: 8px; }
  .usual span { color: var(--quiet); }
  .add { align-self: flex-start; }
</style>
