<script lang="ts">
  import { untrack } from 'svelte';
  import CalendarHeat from '../components/CalendarHeat.svelte';
  import Delta from '../components/Delta.svelte';
  import ActivityChart from '../components/ActivityChart.svelte';
  import ExpenditureCard from '../components/ExpenditureCard.svelte';
  import FoodsCard from '../components/FoodsCard.svelte';
  import Icon from '../components/Icon.svelte';
  import KcalChart from '../components/KcalChart.svelte';
  import MacroChart from '../components/MacroChart.svelte';
  import MicroRow from '../components/MicroRow.svelte';
  import NutrientsCard from '../components/NutrientsCard.svelte';
  import ReviewPanel from '../components/ReviewPanel.svelte';
  import TickBar from '../components/TickBar.svelte';
  import WeekdayChart from '../components/WeekdayChart.svelte';
  import WeightChart from '../components/WeightChart.svelte';
  import { api, ApiError } from '../lib/api';
  import { fromDay } from '../lib/date';
  import { fmt, fmt1, lang, t } from '../lib/i18n';
  import { DETAIL_DAYS, parseQuery, period, PRESETS, shifted, toParams, zoomTarget, type Q, type RangeKey } from '../lib/insightsRange';
  import { microTab, type MicroTab } from '../lib/nutrients.svelte';
  import { DEFAULT_PICK, parsePick, pickParam } from '../lib/nutrientCompare';
  import { reducedMotion } from '../lib/motion.svelte';
  import { navigate, router, setQuery } from '../lib/router.svelte';
  import { loadMe, ui } from '../lib/store.svelte';
  import type { Granularity, Insights, InsightHint, Meal, NutrientCurve, Section, TopMetric } from '../lib/types';

  let data = $state<Insights | null>(null);
  let error = $state('');
  let loading = $state(false);
  let token = 0;
  // ---- the period: everything lives in the URL (range, from, to, g, cmp); zooming keeps a stack to go back
  const q = $derived(parseQuery(router.query, ui.today));
  const want = $derived(period(q, ui.today));
  const invalid = $derived(q.range === 'custom' && !want);
  let stack = $state<Q[]>([]);
  // the nutrient choice is not part of the period: every change of the period keeps it
  const go = (next: Q) => setQuery({ ...toParams(next), ...(router.query.get('nut') ? { nut: router.query.get('nut') as string } : {}) });
  const shown = $derived(data ? { from: data.range.from, to: data.range.to } : want);

  const RANGES: { key: RangeKey; label: () => string }[] = [
    ...PRESETS.map((n) => ({ key: n as RangeKey, label: () => t(`range${n}` as 'range7') })),
    { key: 'all', label: () => t('rangeAll') },
    { key: 'custom', label: () => t('rangeCustom') },
  ];
  function choose(key: RangeKey) {
    stack = [];
    if (key === 'custom') go({ ...q, range: 'custom', from: shown?.from ?? q.from, to: shown?.to ?? q.to });
    else go({ ...q, range: key });
  }
  const setDates = (from: string, to: string) => { stack = []; go({ ...q, range: 'custom', from, to }); };
  const base = $derived(want ?? shown);
  const atToday = $derived(!base || base.to >= ui.today);
  function step(dir: -1 | 1) {
    if (!base) return;
    stack = [];
    const next = shifted(base, dir, ui.today);
    go({ ...q, range: 'custom', ...next });
  }
  const GRANS: { key: Q['g']; label: () => string }[] = [
    { key: 'auto', label: () => t('granAuto') }, { key: 'day', label: () => t('granDay') },
    { key: 'week', label: () => t('granWeek') }, { key: 'month', label: () => t('granMonth') },
  ];
  const setGran = (g: Q['g']) => go({ ...q, g });
  const toggleCompare = () => go({ ...q, compare: !q.compare });
  const days = $derived(data?.range.days ?? 0);

  // click / Enter on a section: months open as weeks, weeks as days, a day opens the day view
  function zoom(sec: Section) {
    const target = zoomTarget(gran, sec);
    if (!target) { ui.day = sec.start; navigate('today'); return; }
    stack = [...stack, q];
    go({ ...q, range: 'custom', from: target.from, to: target.to, g: target.g });
  }
  function back() {
    const prev = stack[stack.length - 1];
    if (!prev) return;
    stack = stack.slice(0, -1);
    go(prev);
  }
  const openDay = (day: string) => { ui.day = day; navigate('today'); };

  // ---- loading (below)

  async function load(from: string | undefined, to: string | undefined, all: boolean, g: Q['g'], compare: boolean) {
    const mine = ++token;
    loading = true;
    try {
      const [result] = await Promise.all([
        api.insights({ from, to, range: all ? 'all' : undefined, granularity: g, compare }),
        ui.me ? Promise.resolve() : loadMe(),
      ]);
      if (mine !== token) return;
      data = result;
      error = '';
    } catch (err) {
      if (mine !== token) return;
      error = err instanceof ApiError ? String(err.status || err.message) : 'error';
    } finally {
      if (mine === token) loading = false;
    }
  }
  const reload = () => void load(want?.from, want?.to, q.range === 'all', q.g, q.compare);
  $effect(() => {
    const [from, to, all, g, cmp] = [want?.from, want?.to, q.range === 'all', q.g, q.compare] as const;
    ui.version;
    if (all || from) untrack(() => { void load(from, to, all, g, cmp); });
  });

  const goal = $derived(data?.goal ?? null);
  // the goal that counts: with active energy added it is the mean of the days' goals (the charts draw this line)
  const effGoal = $derived(goal ? { ...goal, kcal: Math.round(data?.goal_kcal ?? goal.kcal) } : null);
  const goalAdded = $derived(!!goal && !!effGoal && effGoal.kcal !== goal.kcal);
  const logged = $derived(data?.range.logged_days ?? 0);
  const avg = $derived(data?.averages ?? null);
  const gran = $derived<Granularity>(data?.granularity ?? 'day');
  const series = $derived(data?.series ?? []);
  const D = $derived(data?.deltas ?? null);
  const prev = $derived(data?.previous ?? null);
  const dmy = (day: string) => new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'numeric', year: '2-digit' }).format(fromDay(day));

  // calorie goal range as a tick scale: under | in | over, 40 ticks shared out by largest remainder
  const N_TICKS = 40;
  const scale = $derived.by(() => {
    const a = data?.adherence;
    if (!a) return null;
    const parts = [
      { key: 'under', n: a.under_days, h: 9, fill: '#4d8a70' },
      { key: 'in', n: a.in_range_days, h: 18, fill: '#c9f04a' },
      { key: 'over', n: a.over_days, h: 18, fill: '#ffb8d6' },
    ];
    const total = parts.reduce((s, p) => s + p.n, 0);
    if (!total) return { parts, ticks: [] as { h: number; fill: string }[] };
    const raw = parts.map((p) => (p.n / total) * N_TICKS);
    const counts = raw.map((r, i) => (parts[i].n > 0 ? Math.max(1, Math.floor(r)) : 0));
    let rest = N_TICKS - counts.reduce((s, c) => s + c, 0);
    const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).filter((o) => parts[o.i].n > 0).sort((a, b) => b.frac - a.frac);
    for (let k = 0; rest !== 0 && order.length; k = (k + 1) % order.length) {
      const idx = order[k].i;
      if (rest > 0) { counts[idx] += 1; rest -= 1; } else if (counts[idx] > 1) { counts[idx] -= 1; rest += 1; }
    }
    return { parts, ticks: parts.flatMap((p, i) => Array.from({ length: counts[i] }, () => ({ h: p.h, fill: p.fill }))) };
  });

  const tiles = $derived(avg ? [
    { key: 'protein' as const, label: t('protein'), value: avg.protein, goal: goal?.protein ?? null, bg: '#ff8a1f', track: '#b85e0c', radius: '28px 28px 8px 28px' },
    { key: 'carbs' as const, label: t('carbs'), value: avg.carbs, goal: goal?.carbs ?? null, bg: '#c9f04a', track: '#8fb022', radius: '28px' },
    { key: 'fat' as const, label: t('fat'), value: avg.fat, goal: goal?.fat ?? null, bg: '#ffb8d6', track: '#d97aa6', radius: '28px 28px 28px 8px' },
  ] : []);

  // any steps, active energy or workouts in the period: the activity numbers and the card show up
  const hasActivity = $derived(!!data && (data.averages.steps > 0 || data.averages.active_kcal > 0 || data.averages.workout_minutes > 0));
  const balance = $derived(effGoal && avg && logged ? Math.round(avg.kcal - effGoal.kcal) : null);
  const totalWorkoutMin = $derived((data?.averages.workout_minutes ?? 0) * (data?.range.days ?? 0));
  const rawWeights = $derived(data?.weight?.raw ?? (data?.days ?? []).filter((d) => d.weight != null).map((d) => ({ day: d.day, kg: d.weight as number })));

  // ---- nutrients over time: the choice lives in the URL (?nut=magnesium,calcium), without it the default
  const nutSel = $derived(parsePick(router.query.get('nut')));
  function setNut(list: string[]) {
    const params = toParams(q);
    if (list.join() !== DEFAULT_PICK) params.nut = pickParam(list);
    setQuery(params);
  }

  // ---- meals
  const MEAL_STYLE: Record<Meal, { bg: string; fg: string }> = {
    breakfast: { bg: '#ff8a1f', fg: '#17130f' }, lunch: { bg: 'var(--green)', fg: '#ffffff' },
    dinner: { bg: 'var(--series-dark)', fg: '#ffffff' }, snack: { bg: '#ffb8d6', fg: '#17130f' },
  };
  const mealList = $derived((data?.by_meal ?? []).map((m) => `${t(m.meal)} ${fmt(Math.round(m.share * 100))} %`).join(', '));

  // ---- biggest contributors
  const METRICS: { key: TopMetric; label: () => string; unit: string; digits: number }[] = [
    { key: 'kcal', label: () => t('topKcal'), unit: 'kcal', digits: 0 },
    { key: 'sugars', label: () => t('topSugars'), unit: 'g', digits: 0 },
    { key: 'salt', label: () => t('topSalt'), unit: 'g', digits: 1 },
    { key: 'protein', label: () => t('topProtein'), unit: 'g', digits: 0 },
  ];
  let metric = $state<TopMetric>('kcal');
  const metricInfo = $derived(METRICS.find((m) => m.key === metric) ?? METRICS[0]);
  const topList = $derived(data?.top_foods[metric] ?? []);

  // ---- vitamins and minerals: one group at a time, always with how well the values are known
  const MICRO_TABS: MicroTab[] = ['vitamin', 'mineral', 'more'];
  let microGroup = $state<MicroTab>('vitamin');
  const micros = $derived(data?.micros ?? []);
  const microList = $derived(micros.filter((m) => microTab(m.group) === microGroup));

  // ---- hints
  const POSITIVE = new Set(['in_range', 'protein_goal_met']);
  const list = new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' });
  function hintText(h: InsightHint): string {
    const p: Record<string, string | number> = {};
    let key = `hint_${h.code}`;
    for (const [k, v] of Object.entries(h.params)) {
      if (k === 'top') {
        const names = (Array.isArray(v) ? v : v ? [v] : []).map(String);
        if (names.length) { p.top = list.format(names); key += '_top'; }
      } else if (k === 'meal') p.meal = t(String(v) as Meal);
      else p[k] = typeof v === 'number' ? fmt(v, Number.isInteger(v) ? 0 : 1) : String(v ?? '');
    }
    return t(key as 'hint_few_days', p);
  }

  // ---- jump bar
  const JUMPS = [
    { id: 'sec-ov', label: () => t('jumpOverview') }, { id: 'sec-tr', label: () => t('jumpTrends') },
    { id: 'sec-mix', label: () => t('jumpMix') }, { id: 'sec-foods', label: () => t('jumpFoods') },
  ];
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  const titleOfGran = $derived(gran === 'day' ? t('chartKcal') : gran === 'week' ? t('chartKcalWeekly') : t('chartKcalMonthly'));
</script>

{#snippet nogoal()}
  <p class="nogoal-note">{t('insNoGoalShort')} <a href="#/profile">{t('setGoal')}</a></p>
{/snippet}

<div class="page wide insights">
  <div class="page-head">
    <h1>{t('historyTitle')}</h1>
    {#if data}<span class="micro quiet range">{dmy(data.range.from)} – {dmy(data.range.to)}</span>{/if}
  </div>

  <div class="toolbar">
    <div class="ranges" role="group" aria-label={t('rangeLabel')}>
      {#each RANGES as r (r.key)}
        <button class="chip" class:on={q.range === r.key} aria-pressed={q.range === r.key} onclick={() => choose(r.key)}>{r.label()}</button>
      {/each}
    </div>
    <div class="steps">
      <button class="round" onclick={() => step(-1)} disabled={q.range === 'all' || !base} aria-label={t('prevPeriod')}><Icon name="left" size={22} /></button>
      <button class="round" onclick={() => step(1)} disabled={q.range === 'all' || atToday} aria-label={t('nextPeriod')}><Icon name="right" size={22} /></button>
      {#if stack.length}<button class="chip back" onclick={back}><Icon name="left" size={18} />{t('zoomBack')}</button>{/if}
    </div>
    <div class="gran" role="group" aria-label={t('granLabel')}>
      {#each GRANS as g (g.key)}
        <button class="chip small" class:on={q.g === g.key} aria-pressed={q.g === g.key} disabled={g.key === 'day' && days > DETAIL_DAYS + 30} onclick={() => setGran(g.key)}>{g.label()}</button>
      {/each}
    </div>
  </div>
  <div class="rowb">
    <button class="switch" role="switch" aria-checked={q.compare} onclick={toggleCompare}>
      <span class="track" class:on={q.compare} aria-hidden="true"><span class="knob"></span></span>
      <span>{t('compareLabel')}</span>
    </button>
    {#if data && !invalid}
      <nav class="jump" aria-label={t('jumpLabel')}>
        {#each JUMPS as j (j.id)}<button class="chip small" onclick={() => jump(j.id)}>{j.label()}</button>{/each}
      </nav>
    {/if}
  </div>
  {#if q.range === 'custom'}
    <div class="dates">
      <label class="field"><span>{t('rangeFrom')}</span><input type="date" value={q.from} max={q.to} onchange={(e) => setDates(e.currentTarget.value, q.to)} /></label>
      <label class="field"><span>{t('rangeTo')}</span><input type="date" value={q.to} min={q.from} onchange={(e) => setDates(q.from, e.currentTarget.value)} /></label>
    </div>
    {#if invalid}<p class="note warn" role="alert">{t('rangeBad')}</p>{/if}
  {/if}

  {#if invalid}
    <!-- invalid range: the warning above says why; showing the previous range's numbers would mislead -->
  {:else if error && !data}
    <div class="error-box"><p>{t('loadFailed', { reason: error })}</p><button class="btn primary" onclick={reload}>{t('retry')}</button></div>
  {:else if !data}
    <div class="skel hero-skel" aria-hidden="true"></div>
    <div class="row2" aria-hidden="true"><div class="skel wide-card"></div><div class="skel"></div></div>
  {:else}
    <div class="body" class:stale={loading}>
      <section id="sec-ov" class="sec" aria-labelledby="t-ov">
        <h2 id="t-ov" class="sec-h display">{t('secOverview')}</h2>
        <div class="hero on-dark">
          <div class="stat">
            <span class="micro lab">{t('insAvgKcal')}</span>
            <span class="big">{logged && avg ? fmt(Math.round(avg.kcal)) : '–'}<small> kcal</small></span>
            {#if q.compare && D}<Delta d={D.kcal} unit="kcal" dark />{/if}
          </div>
          <div class="stat">
            <span class="micro lab">{t('insLoggedDays')}</span>
            <span class="big">{logged}<small> / {data.range.days}</small></span>
            {#if q.compare && prev}<span class="mono prevtxt">{t('cmpLoggedBefore', { n: prev.logged_days })}</span>{/if}
          </div>
          {#if hasActivity}
            <div class="stat">
              <span class="micro lab">{t('insActAvgSteps')}</span>
              <span class="big">{avg && avg.steps ? fmt(Math.round(avg.steps)) : '–'}</span>
              {#if q.compare && D?.steps}<Delta d={D.steps} unit="" dark />{/if}
            </div>
            <div class="stat">
              <span class="micro lab">{t('insActAvgActive')}</span>
              <span class="big">{avg && avg.active_kcal ? fmt(Math.round(avg.active_kcal)) : '–'}<small> kcal</small></span>
              {#if q.compare && D?.active_kcal}<Delta d={D.active_kcal} unit="kcal" dark />{/if}
            </div>
          {/if}
          <div class="stat goalrange" class:tall={hasActivity}>
            <span class="micro lab">{t('insGoalRange')}</span>
            {#if scale && scale.ticks.length}
              <svg class="ticks" viewBox="0 0 {N_TICKS * 6 - 3} 20" preserveAspectRatio="none" height="26" width="100%" role="img"
                aria-label={t('insAdherenceAria', { in: data.adherence?.in_range_days ?? 0, over: data.adherence?.over_days ?? 0, under: data.adherence?.under_days ?? 0 })}>
                {#each scale.ticks as tk, i}<rect x={i * 6} y={20 - tk.h} width="3" height={tk.h} rx="1.5" fill={tk.fill} />{/each}
              </svg>
              <ul class="mono key">
                <li>{t('insUnder')} <b>{scale.parts[0].n}</b></li>
                <li>{t('insIn')} <b>{scale.parts[1].n}</b></li>
                <li>{t('insOver')} <b>{scale.parts[2].n}</b></li>
                {#if q.compare && D?.in_range_share}<li><Delta d={D.in_range_share} unit={t('deltaPp')} digits={0} dark /></li>{/if}
              </ul>
            {:else if !goal}
              <p class="hero-note">{t('insNoGoal')} <a href="#/profile">{t('setGoal')}</a></p>
            {:else}
              <span class="big">–</span>
            {/if}
          </div>
        </div>
        {#if q.compare && prev && prev.logged_days === 0}<p class="note">{t('cmpNoPrev')}</p>
        {:else if q.compare && prev}<p class="note">{t('cmpNote', { n: prev.range.days })} {dmy(prev.range.from)} – {dmy(prev.range.to)}</p>{/if}

        <div class="row2 start">
          <ReviewPanel />
          {#if logged > 0}
            <section class="card" aria-labelledby="h-hints">
              <h3 id="h-hints" class="micro quiet">{t('hintsTitle')}</h3>
              <ul class="hints">
                {#each data.hints as h (h.code)}
                  <li class="hint" class:good={POSITIVE.has(h.code)}>
                    <span class="micro ht">{t(`hintT_${h.code}` as 'hintT_few_days')}</span>
                    <p>{hintText(h)}</p>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        </div>
      </section>

      {#if logged === 0}
        <section class="empty">
          <h2 class="display">{t('insEmptyTitle')}</h2>
          <p>{t('insEmptyText')}</p>
          <button class="btn primary" onclick={() => { ui.day = ui.today; navigate('today'); }}>{t('insToToday')}</button>
        </section>
      {:else if avg}
        <section id="sec-tr" class="sec" aria-labelledby="t-tr">
          <h2 id="t-tr" class="sec-h display">{t('secTrends')}</h2>

          <section class="card" aria-labelledby="h-kcal">
            <h3 id="h-kcal" class="micro quiet">{titleOfGran}</h3>
            <KcalChart {series} previous={q.compare ? prev?.series ?? null : null} goal={effGoal} {gran} onzoom={zoom} />
            {#if !goal}{@render nogoal()}{:else}<p class="note keyline"><span class="swatch band"></span>{t('goalBand')}{#if goalAdded} {t('insGoalWithActive', { n: fmt(effGoal?.kcal ?? 0) })}{/if}</p>{/if}
          </section>

          {#if hasActivity}
            <section class="card" aria-labelledby="h-act">
              <h3 id="h-act" class="micro quiet">{t('insActTitle')} <span class="sub">· {t('insActStepsNote')}</span></h3>
              <ActivityChart {series} previous={q.compare ? prev?.series ?? null : null} goal={data.steps_goal ?? goal?.steps ?? 8000} {gran} />
              <ul class="extras mono">
                <li><span class="micro quiet">{t('insActAvgSteps')}</span> {fmt(Math.round(avg.steps))} {#if q.compare && D}<Delta d={D.steps} unit="" />{/if}</li>
                <li><span class="micro quiet">{t('insActAvgActive')}</span> {fmt(Math.round(avg.active_kcal))} kcal {#if q.compare && D}<Delta d={D.active_kcal} unit="kcal" />{/if}</li>
                <li><span class="micro quiet">{t('insActWorkoutMin')}</span> {t('insActTotalMin', { n: fmt(Math.round(totalWorkoutMin)) })}
                  <span class="quiet">· {t('insActWorkoutPerDay', { n: fmt(avg.workout_minutes, 0) })}</span> {#if q.compare && D}<Delta d={D.workout_minutes} unit="min" />{/if}</li>
              </ul>
            </section>
          {:else}
            <section class="card" aria-labelledby="h-act">
              <h3 id="h-act" class="micro quiet">{t('insActTitle')}</h3>
              <p class="note">{t('insActNone')}</p>
            </section>
          {/if}

          <section class="card" aria-labelledby="h-macro">
            <h3 id="h-macro" class="micro quiet">{t('macroTrend')} <span class="sub">· {t('macroTrendNote')}</span></h3>
            <MacroChart {series} {gran} />
            <h3 id="h-macro2" class="micro quiet sp">{t('macroTitle')}</h3>
            <div class="tiles">
              {#each tiles as tile}
                <div class="tile" style="background:{tile.bg}; border-radius:{tile.radius}" role="group"
                  aria-label={t('macroAvgAria', { label: tile.label, value: fmt(tile.value), goal: tile.goal ? t('macroGoalPart', { goal: fmt(tile.goal) }) : '' })}>
                  <span class="tl">{tile.label}{#if q.compare && D}<Delta d={D[tile.key]} unit="g" pct={false} />{/if}</span>
                  <span class="tv display">{fmt(Math.round(tile.value))}{#if tile.goal}<span class="mono unit"> /{fmt(tile.goal)} g</span>{:else}<span class="mono unit"> g</span>{/if}</span>
                  <TickBar value={tile.value} goal={tile.goal} track={tile.track} label="" />
                </div>
              {/each}
            </div>
            <ul class="extras mono">
              <li><span class="micro quiet">{t('sugars')}</span> {fmt1(avg.sugars)} g {#if q.compare && D}<Delta d={D.sugars} unit="g" digits={1} />{/if}</li>
              <li><span class="micro quiet">{t('fiber')}</span> {fmt1(avg.fiber)} g {#if q.compare && D}<Delta d={D.fiber} unit="g" digits={1} />{/if}</li>
              <li><span class="micro quiet">{t('salt')}</span> {fmt1(avg.salt)} g {#if q.compare && D}<Delta d={D.salt} unit="g" digits={1} />{/if}</li>
              {#if avg.water_ml}<li><span class="micro quiet">{t('insWater')}</span> {t('waterLitres', { n: fmt(avg.water_ml / 1000, 2) })} {#if q.compare && D}<Delta d={D.water_ml} unit="ml" />{/if}</li>{/if}
            </ul>
            {#if !goal}{@render nogoal()}{/if}
          </section>

          <div class="row2">
            <section class="card" aria-labelledby="h-weight">
              <h3 id="h-weight" class="micro quiet">{t('wtTitle')}</h3>
              {#if data.weight}
                <div class="kpis">
                  <div><span class="micro quiet">{t('wtChange')}</span>
                    <span class="num display">{data.weight.change > 0 ? '+' : ''}{fmt1(data.weight.change)}<small class="mono"> kg</small></span>
                    {#if q.compare && D?.weight_change}<Delta d={D.weight_change} unit="kg" digits={1} pct={false} />{/if}</div>
                  <div><span class="micro quiet">{t('wtBalance')}</span>
                    {#if balance != null}<span class="num display">{balance > 0 ? '+' : ''}{fmt(balance)}<small class="mono"> {t('wtPerDay')}</small></span>
                      <span class="note">{balance <= 0 ? t('wtBalanceUnder') : t('wtBalanceOver')}</span>
                    {:else}<span class="num display">–</span>{/if}</div>
                </div>
                <WeightChart from={data.range.from} to={data.range.to} weight={data.weight} raw={rawWeights} />
              {:else}
                <p class="note">{t('wtNone')} <a href="#/weight">{t('wtAdd')}</a></p>
                {#if balance != null}
                  <div class="kpis"><div><span class="micro quiet">{t('wtBalance')}</span>
                    <span class="num display">{balance > 0 ? '+' : ''}{fmt(balance)}<small class="mono"> {t('wtPerDay')}</small></span>
                    <span class="note">{balance <= 0 ? t('wtBalanceUnder') : t('wtBalanceOver')}</span></div></div>
                {/if}
              {/if}
              {#if !goal}{@render nogoal()}{/if}
            </section>

            <section class="card" aria-labelledby="h-exp">
              <h3 id="h-exp" class="micro quiet">{t('expTitle')}</h3>
              <ExpenditureCard exp={data.expenditure ?? null} missing={data.expenditure_missing ?? []} goal={effGoal} />
            </section>
          </div>

          <section class="card" aria-labelledby="h-nut">
            <h3 id="h-nut" class="micro quiet">{t('nutTitle')}</h3>
            <NutrientsCard {data} sel={nutSel} onsel={setNut} />
          </section>

          <section class="card" aria-labelledby="h-cal">
            <h3 id="h-cal" class="micro quiet">{t('calTitle')}</h3>
            {#if data.calendar && data.calendar.length}
              <CalendarHeat cal={data.calendar} days={data.days} onopen={openDay} />
            {:else}<p class="note">{t('calTooLong')}</p><button class="chip small cal-year" onclick={() => choose('365')}>{t('calShowYear')}</button>{/if}
          </section>
        </section>

        <section id="sec-mix" class="sec" aria-labelledby="t-mix">
          <h2 id="t-mix" class="sec-h display">{t('secMix')}</h2>
          <div class="row2">
            <section class="card" aria-labelledby="h-wd">
              <h3 id="h-wd" class="micro quiet">{t('weekdaysTitle')}</h3>
              <WeekdayChart data={data.by_weekday} goal={effGoal} />
            </section>

            <section class="card" aria-labelledby="h-meals">
              <h3 id="h-meals" class="micro quiet">{t('mealsTitle')}</h3>
              <div class="stack" role="img" aria-label={t('mealsAria', { list: mealList })}>
                {#each data.by_meal.filter((m) => m.share > 0) as m}
                  <span style="flex: {m.share} 1 0; background:{MEAL_STYLE[m.meal].bg}; color:{MEAL_STYLE[m.meal].fg}" class="seg mono">{m.share >= 0.1 ? `${Math.round(m.share * 100)}` : ''}</span>
                {/each}
              </div>
              <ul class="legend">
                {#each data.by_meal as m}
                  <li><span class="sw" style="background:{MEAL_STYLE[m.meal].bg}"></span><span class="nm">{t(m.meal)}</span>
                    <span class="mono vl">{fmt(Math.round(m.kcal))} kcal <span class="quiet">· {fmt(Math.round(m.share * 100))} %</span></span></li>
                {/each}
              </ul>
              <p class="note">{t('mealPerDay')}</p>
            </section>
          </div>

          <section class="card" aria-labelledby="h-micros">
            <h3 id="h-micros" class="micro quiet">{t('microsTitle')}</h3>
            {#if micros.length}
              <div class="seg-ctl" role="group" aria-label={t('microsTitle')}>
                {#each MICRO_TABS as g}
                  <button class="chip" class:on={microGroup === g} aria-pressed={microGroup === g} onclick={() => (microGroup = g)}>{t(`microTab_${g}` as 'microTab_vitamin')}</button>
                {/each}
              </div>
              <p class="note">{t('microNote')}</p>
              {#if microList.length}
                <ul class="mlist">
                  {#each microList as m (m.key)}
                    <MicroRow key={m.key} unit={m.unit} amount={m.average} nrv={m.nrv} coverage={m.coverage} />
                  {/each}
                </ul>
              {:else}<p class="note">{t('microNoneTab')}</p>{/if}
            {:else}<p class="note">{t('microNone')}</p>{/if}
          </section>

          <section class="card" aria-labelledby="h-top">
            <h3 id="h-top" class="micro quiet">{t('topTitle')}</h3>
            <div class="seg-ctl" role="group" aria-label={t('topTitle')}>
              {#each METRICS as m}
                <button class="chip" class:on={metric === m.key} aria-pressed={metric === m.key} onclick={() => (metric = m.key)}>{m.label()}</button>
              {/each}
            </div>
            {#if topList.length}
              <ul class="top">
                {#each topList as f (f.name + (f.brand ?? ''))}
                  <li>
                    <div class="line">
                      <span class="t"><strong>{f.name}</strong><small>{[f.brand, t('topTimes', { n: f.times })].filter(Boolean).join(' · ')}</small></span>
                      <span class="mono v">{fmt(f.value, metricInfo.digits)} {metricInfo.unit}<small>{t('topShare', { n: fmt(Math.round(f.share * 100)) })}</small></span>
                    </div>
                    <TickBar value={f.share} goal={topList[0].share} track="var(--track)" fill="var(--bar)" label="" height={8} />
                  </li>
                {/each}
              </ul>
            {:else}<p class="note">{t('topNone')}</p>{/if}
          </section>
        </section>

        <section id="sec-foods" class="sec" aria-labelledby="t-foods">
          <h2 id="t-foods" class="sec-h display">{t('secFoods')}</h2>
          <section class="card" aria-labelledby="h-foods">
            <h3 id="h-foods" class="micro quiet">{t('foodsTitle')}</h3>
            <FoodsCard from={data.range.from} to={data.range.to} />
          </section>
        </section>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* phone: the menu button takes the right end of the title row, so the period sits under the title instead of wrapping */
  .range { white-space: nowrap; }
  @media (max-width: 899px) { .insights :global(.page-head) { flex-direction: column; align-items: flex-start; gap: 6px; } }
  .page.insights { gap: 14px; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; }
  .ranges, .gran { display: flex; flex-wrap: wrap; gap: 8px; }
  .gran { gap: 6px; }
  .chip.small { min-height: 38px; padding: 0 13px; font-size: 13px; }
  .chip[disabled] { opacity: 0.45; cursor: default; }
  .steps { display: flex; align-items: center; gap: 6px; }
  .round[disabled] { opacity: 0.4; cursor: default; }
  .chip.back { background: var(--sel-bg); color: var(--sel-fg); border-color: var(--sel-bg); padding: 0 16px 0 10px; }
  .switch { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; font-size: 14px; font-weight: 600; text-align: left; }
  .switch .track { width: 46px; height: 26px; border-radius: 13px; background: var(--track); border: 2px solid var(--field-line); position: relative; flex-shrink: 0; transition: background 160ms; }
  .switch .track.on { background: var(--toggle-on); border-color: var(--toggle-on); }
  .switch .knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 9px; background: var(--paper); border: 1.5px solid var(--quiet); transition: transform 160ms; }
  .switch .track.on .knob { transform: translateX(20px); border-color: var(--paper); }
  .dates { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; max-width: 420px; }
  .dates .field { min-width: 0; }
  .dates input { min-width: 0; }
  .cal-year { align-self: flex-start; }
  .rowb { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 18px; }
  .jump { display: flex; gap: 6px; overflow-x: auto; padding: 2px 0; }
  .jump .chip { flex-shrink: 0; }

  .body { display: flex; flex-direction: column; gap: 26px; transition: opacity 160ms; }
  .body.stale { opacity: 0.55; }
  .sec { display: flex; flex-direction: column; gap: 12px; scroll-margin-top: 70px; }
  .sec-h { font-size: 26px; line-height: 1.05; margin-top: 4px; }
  .row2 { display: flex; flex-direction: column; gap: 12px; }
  .skel { height: 220px; border-radius: 28px 28px 28px 8px; background: var(--hairline); opacity: 0.5; }
  .hero-skel { height: 170px; border-radius: 44px 44px 44px 14px; }

  .hero {
    background: var(--green); color: #fff; border-radius: 44px 44px 44px 14px; padding: 22px 24px 24px;
    display: grid; grid-template-columns: 1fr 1fr; gap: 18px 16px; --focus: var(--lime);
  }
  .stat { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; }
  .goalrange { grid-column: 1 / -1; align-items: stretch; }
  .lab { color: #d5ead0; }
  .big { font-family: var(--f-display); font-weight: 800; font-size: 40px; letter-spacing: -0.04em; line-height: 1.02; white-space: nowrap; }
  .big small { margin-left: 4px; font-family: var(--f-mono); font-size: 14px; font-weight: 500; letter-spacing: 0; }
  .prevtxt { font-size: 12px; color: #d5ead0; }
  .ticks { display: block; margin-top: 6px; }
  .key { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 20px; font-size: 13px; margin-top: 4px; color: #e8f2e4; }
  .key b { font-weight: 600; color: #fff; margin-left: 3px; }
  .hero-note { font-size: 14px; margin-top: 2px; }
  .hero-note a { color: var(--lime); }

  .empty { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 22px; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
  .empty h2 { font-size: 26px; line-height: 1.05; }
  .empty p { color: var(--quiet); }

  .card { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 18px 18px 20px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .card h3 { font-size: 11px; font-weight: 500; }
  .card h3 .sub { text-transform: none; letter-spacing: 0; font-family: var(--f-body); font-size: 12px; }
  .card h3.sp { margin-top: 8px; }
  .nogoal-note { font-size: 13px; color: var(--quiet); }
  .nogoal-note a, .note a { color: var(--green-text); font-weight: 600; }
  .keyline { display: flex; align-items: center; gap: 8px; }
  .swatch { width: 16px; height: 10px; border-radius: 3px; display: inline-block; }
  .swatch.band { background: color-mix(in srgb, var(--bar) 20%, transparent); border: 1.5px solid var(--bar); }

  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .tile { height: 96px; color: var(--on-tile); padding: 12px 10px 12px 12px; display: flex; flex-direction: column; justify-content: space-between; min-width: 0; }
  .tl { font-size: 12px; font-weight: 600; letter-spacing: -0.01em; display: flex; flex-wrap: wrap; gap: 2px 6px; align-items: center; }
  .tl :global(.delta) { font-size: 10.5px; padding: 0 6px; }
  .tv { font-size: 24px; line-height: 1; white-space: nowrap; }
  .unit { font-size: 11px; font-weight: 500; letter-spacing: 0; }
  .extras { display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 14px; font-weight: 600; }
  .extras li { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .extras .micro { margin-right: 2px; }

  .kpis { display: flex; flex-wrap: wrap; gap: 10px 28px; }
  .kpis > div { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
  .num { font-size: 30px; line-height: 1.05; }
  .num small { font-size: 12px; font-weight: 500; letter-spacing: 0; margin-left: 3px; }

  .stack { display: flex; gap: 3px; height: 44px; }
  .seg { border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; min-width: 6px; }
  .stack .seg:first-child { border-radius: 20px 10px 10px 20px; }
  .stack .seg:last-child { border-radius: 10px 20px 20px 10px; }
  .legend { display: flex; flex-direction: column; gap: 6px; }
  .legend li { display: flex; align-items: center; gap: 10px; min-height: 28px; }
  .sw { width: 16px; height: 16px; border-radius: 6px 6px 6px 3px; flex-shrink: 0; }
  .nm { font-weight: 600; flex: 1; }
  .vl { font-size: 13px; font-weight: 600; white-space: nowrap; }

  .seg-ctl { display: flex; flex-wrap: wrap; gap: 6px; }
  .seg-ctl .chip { min-height: 40px; padding: 0 14px; font-size: 13px; }
  .top { display: flex; flex-direction: column; gap: 12px; }
  .top li { display: flex; flex-direction: column; gap: 5px; }
  .line { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .t { display: flex; flex-direction: column; min-width: 0; }
  .t strong { font-size: 14px; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t small { font-size: 12px; color: var(--quiet); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v { font-size: 14px; font-weight: 600; text-align: right; white-space: nowrap; display: flex; flex-direction: column; }
  .v small { font-size: 11px; font-weight: 500; color: var(--quiet); }

  .hints { display: flex; flex-direction: column; gap: 8px; }
  .hint { background: var(--stone); border-radius: 20px 20px 20px 8px; padding: 12px 16px 14px; display: flex; flex-direction: column; gap: 4px; }
  .hint.good { background: var(--lime); color: var(--on-lime); }
  .hint .ht { color: var(--quiet); }
  .hint.good .ht { color: #2c3a14; }
  .hint p { font-size: 14px; line-height: 1.4; }
  .mlist { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px 40px; }

  @media (min-width: 900px) {
    .page.wide.insights { max-width: 1320px; }
    .hero { grid-template-columns: 1fr 1fr 1.7fr; align-items: end; padding: 26px 32px 28px; }
    .goalrange { grid-column: auto; }
    .goalrange.tall { grid-row: 1 / span 2; grid-column: 3; align-self: center; }
    .big { font-size: 48px; }
    .row2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: stretch; }
    .row2.start { align-items: start; }
    .card { padding: 22px 24px 24px; }
    .tile { height: 104px; }
    .top { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 40px; }
    .mlist { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .sec-h { font-size: 30px; }
  }
  @media (min-width: 1200px) { .mlist { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
</style>
