<script lang="ts">
  import { untrack } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import WeightChart from '../components/WeightChart.svelte';
  import { bodyChange, bodyPoints, type BodyKey } from '../lib/body';
  import { shiftDay, shortDate } from '../lib/date';
  import { fmt, fmt1, inputNumber, parseNumber, t } from '../lib/i18n';
  import { wide } from '../lib/media.svelte';
  import { checkBadges, toast, ui } from '../lib/store.svelte';
  import type { WeightPoint } from '../lib/types';
  import { readingOf, trendOf } from '../lib/weightTrend';

  // the chart's period, remembered per browser; the change tiles always look back up to 90 days, so at least that is loaded
  const RANGES = [30, 90, 365, 0] as const; // 0 = everything
  const RANGE_KEY = 'mahlwerk.weightDays';
  const readRange = () => { try { const raw = localStorage.getItem(RANGE_KEY); return raw != null && (RANGES as readonly number[]).includes(Number(raw)) ? Number(raw) : 90; } catch { return 90; } };
  let range = $state<number>(readRange());
  function chooseRange(v: number) {
    range = v;
    try { localStorage.setItem(RANGE_KEY, String(v)); } catch { /* private mode: not remembered */ }
    void load();
  }
  const DAYS = 90;
  let points = $state<WeightPoint[] | null>(null);
  let text = $state('');
  let fatText = $state('');
  let leanText = $state('');
  let error = $state('');
  let saving = $state(false);
  let primed = false;

  async function load() {
    try {
      points = await api.weights(range === 0 ? 3660 : Math.max(range, DAYS));
      if (!primed) {
        primed = true;
        const todayValue = points.find((p) => p.day === ui.today);
        const seed = todayValue ?? points[points.length - 1];
        text = seed ? inputNumber(seed.kg) : '';
        // body values belong to the day they were measured: only today's are offered for editing
        fatText = todayValue?.body_fat_pct != null ? inputNumber(todayValue.body_fat_pct) : '';
        leanText = todayValue?.lean_kg != null ? inputNumber(todayValue.lean_kg) : '';
      }
    } catch (err) {
      error = t('loadFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    }
  }
  $effect(() => { ui.version; untrack(() => { void load(); }); });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const kg = parseNumber(text);
    if (kg == null || Number.isNaN(kg) || kg < 20 || kg > 400) { error = t('weightBad'); return; }
    // an empty field clears a value stored for today, and is left out when there is none
    const body: { body_fat_pct?: number | null; lean_kg?: number | null } = {};
    const stored = points?.find((p) => p.day === ui.today);
    for (const [key, raw, lo, hi] of [['body_fat_pct', fatText, 2, 75], ['lean_kg', leanText, 20, 300]] as const) {
      if (raw.trim() === '') { if (stored?.[key] != null) body[key] = null; continue; }
      const v = parseNumber(raw);
      if (v == null || Number.isNaN(v) || v < lo || v > hi) { error = t('bodyBad'); return; }
      body[key] = v;
    }
    saving = true;
    error = '';
    try {
      await api.setWeight(ui.today, kg, body);
      toast(t('weightSaved'));
      checkBadges();
      await load();
    } catch (err) {
      error = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      saving = false;
    }
  }

  async function removeToday() {
    try { await api.deleteWeight(ui.today); toast(t('weightDeleted')); await load(); }
    catch (err) { error = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' }); }
  }

  const hasToday = $derived(!!points?.some((p) => p.day === ui.today));
  const latest = $derived(points && points.length ? points[points.length - 1] : null);
  // the values in the chosen period (points may reach further back for the change tiles)
  const start = $derived(range ? shiftDay(ui.today, -(range - 1)) : points?.[0]?.day ?? ui.today);
  const shown = $derived(points ? points.filter((p) => p.day >= start) : null);
  const first = $derived(shown && shown.length ? shown[0] : null);
  const delta = $derived(latest && first && latest !== first ? latest.kg - first.kg : null);

  // the trend over all loaded values (so its start in the chosen period is not cut off), and the latest value read against it
  const trend = $derived(points ? trendOf(points) : []);
  const reading = $derived(points ? readingOf(points, ui.today) : null);
  const chartWeight = $derived(latest && first ? { first: first.kg, last: latest.kg, change: Math.round((latest.kg - first.kg) * 100) / 100, trend: trend.filter((p) => p.day >= start) } : null);
  // key figures, all from the stored values: the change since the latest value that is at least n days older
  const changeOver = (n: number) => {
    if (!points || !latest) return null;
    const cutoff = shiftDay(latest.day, -n);
    const base = [...points].reverse().find((p) => p.day <= cutoff);
    return base ? Math.round((latest.kg - base.kg) * 10) / 10 : null;
  };
  const changes = $derived([
    { days: 7, v: changeOver(7), bg: '#c9f04a', radius: '28px' },
    { days: 30, v: changeOver(30), bg: '#ff8a1f', radius: '28px 28px 8px 28px' },
    { days: 90, v: changeOver(DAYS - 1), bg: '#ffb8d6', radius: '28px 28px 28px 8px' },
  ]);
  // body composition tiles: only with body fat values; fat and lean mass are worked out per day (see lib/body.ts)
  const body = $derived(bodyPoints(points ?? []));
  const bodyLatest = $derived(body.length ? body[body.length - 1] : null);
  const bodyTiles = $derived(bodyLatest ? ([
    { key: 'pct', label: t('bodyFat'), unit: '%', bg: '#ffb8d6', radius: '28px 28px 28px 8px' },
    { key: 'fat', label: t('wFatMass'), unit: t('kg'), bg: '#ff8a1f', radius: '28px 28px 8px 28px' },
    { key: 'lean', label: t('leanMass'), unit: t('kg'), bg: '#c9f04a', radius: '28px' },
  ] as { key: BodyKey; label: string; unit: string; bg: string; radius: string }[]).map((m) => ({
    ...m,
    value: bodyLatest[m.key],
    changes: [7, 30, DAYS - 1].map((n) => ({ n: n === DAYS - 1 ? DAYS : n, v: bodyChange(body, m.key, shiftDay(bodyLatest.day, -n)) })),
  })) : []);
  const lowest = $derived(shown && shown.length ? Math.min(...shown.map((p) => p.kg)) : null);
  const highest = $derived(shown && shown.length ? Math.max(...shown.map((p) => p.kg)) : null);
  const recent = $derived(
    points ? [...points].reverse().slice(0, 14).map((p, i, all) => {
      const before = all[i + 1];
      return { ...p, d: before ? Math.round((p.kg - before.kg) * 10) / 10 : null };
    }) : [],
  );
  const signed = (v: number) => `${v > 0 ? '+' : ''}${fmt1(v)}`;
  const pace = (v: number) => `${v > 0 ? '+' : ''}${fmt(v, 2)}`;
  const when = (day: string) => (day === ui.today ? t('trToday') : shortDate(day));
  const rangeLabel = (v: number) => (v === 0 ? t('rangeAll') : v === 365 ? t('range365') : t('wDays', { n: v }));
  const chartLabel = $derived(range === 0 ? t('weightChartAll') : t('weightChart', { n: range }));
</script>

<div class="page split">
  <div class="page-head"><h1>{t('weightTitle')}</h1><span class="micro quiet">{shortDate(ui.today)}</span></div>

  <div class="cols">
  <div class="main">
  <form class="entry" onsubmit={save}>
    <label class="field">
      <span>{t('weightToday')} ({t('kg')})</span>
      <input inputmode="decimal" autocomplete="off" bind:value={text} aria-invalid={error === t('weightBad') ? 'true' : undefined} />
    </label>
    <button class="btn primary" disabled={saving}>{t('weightSave')}</button>
    <div class="body">
      <label class="field">
        <span>{t('bodyFat')} (%) · {t('bodyOptional')}</span>
        <input inputmode="decimal" autocomplete="off" bind:value={fatText} aria-invalid={error === t('bodyBad') ? 'true' : undefined} />
      </label>
      <label class="field">
        <span>{t('leanMass')} ({t('kg')}) · {t('bodyOptional')}</span>
        <input inputmode="decimal" autocomplete="off" bind:value={leanText} aria-invalid={error === t('bodyBad') ? 'true' : undefined} />
      </label>
    </div>
  </form>
  {#if error}<p class="note warn" role="alert">{error}</p>{/if}

  {#if points && points.length === 0}
    <p class="note">{t('weightEmpty')}</p>
  {:else if shown && shown.length && chartWeight && latest}
    <section class="card on-dark">
      <div class="kpi">
        <div><span class="micro lab">{t('weightLatest')}</span><span class="val">{fmt1(latest.kg)}<small> {t('kg')}</small></span></div>
        {#if delta != null && first}<div class="chg"><span class="mono">{delta > 0 ? '+' : ''}{fmt1(Math.round(delta * 10) / 10)} {t('kg')}</span><span class="micro lab">{t('weightChange', { day: shortDate(first.day).split(' ')[1] })}</span></div>{/if}
      </div>
      {#if reading && (reading.pace !== null || reading.spread !== null)}
        <div class="reading" aria-label={t('trCard')}>
          {#if reading.pace !== null}<span class="pace">{reading.steady ? t('trSteady') : t('trPace', { v: pace(reading.pace) })}</span>{/if}
          {#if reading.spread !== null}
            <p>{reading.deviation === 0 ? t('trOn', { when: when(reading.day) })
              : t(reading.deviation > 0 ? 'trAbove' : 'trBelow', { when: when(reading.day), v: fmt1(Math.abs(reading.deviation)) })}
              · {#if reading.unusual}<span class="unusual">{t('trUnusual', { v: fmt1(reading.spread) })}</span>{:else}{t('trUsual', { v: fmt1(reading.spread) })}{/if}</p>
          {/if}
        </div>
      {/if}
    </section>
    <div class="ranges" role="group" aria-label={t('rangeLabel')}>
      {#each RANGES as v}
        <button class="chip small" class:on={range === v} aria-pressed={range === v} onclick={() => chooseRange(v)}>{rangeLabel(v)}</button>
      {/each}
    </div>
    <figure>
      <WeightChart from={start} to={ui.today} today={ui.today} weight={chartWeight} raw={shown} spread={reading?.spread ?? null} />
      <figcaption class="micro quiet">{chartLabel}</figcaption>
    </figure>
  {/if}
  {#if bodyTiles.length}
    <section class="btiles" aria-label={t('wBodyTiles')}>
      {#each bodyTiles as m (m.key)}
        <div class="btile" style="background:{m.bg}; border-radius:{m.radius}">
          <span class="tl">{m.label}</span>
          <span class="tv display">{fmt1(m.value)}<span class="mono unit"> {m.unit}</span></span>
          <div class="bch">
            {#each m.changes as c (c.n)}
              <span><span class="micro bd">{t('wDays', { n: c.n })}</span><span class="mono bv">{c.v == null ? '–' : signed(c.v)}</span></span>
            {/each}
          </div>
        </div>
      {/each}
    </section>
  {/if}
  {#if hasToday}<button class="btn quiet-btn" onclick={removeToday}>{t('weightDelete')}</button>{/if}
  </div>

  {#if wide.on && points && points.length > 0 && latest}
    <aside class="side" aria-label={t('wChange')}>
      <section class="tiles">
        {#each changes as c}
          <div class="tile" style="background:{c.bg}; border-radius:{c.radius}">
            <span class="tl">{t('wChange')} · {t('wDays', { n: c.days === 90 ? DAYS : c.days })}</span>
            <span class="tv display">{c.v == null ? '–' : signed(c.v)}<span class="mono unit"> {c.v == null ? '' : t('kg')}</span></span>
          </div>
        {/each}
      </section>
      <section class="stats">
        <div><span class="micro quiet">{t('wLowest')}</span><span class="sv display">{lowest == null ? '–' : fmt1(lowest)}<small> {t('kg')}</small></span></div>
        <div><span class="micro quiet">{t('wHighest')}</span><span class="sv display">{highest == null ? '–' : fmt1(highest)}<small> {t('kg')}</small></span></div>
        <div><span class="micro quiet">{t('wEntriesCount')}</span><span class="sv display">{shown?.length ?? 0}</span></div>
      </section>
      <section class="log">
        <h2 class="micro quiet">{t('wRecent')}</h2>
        <ul class="rows">
          {#each recent as r (r.day)}
            <li class="row-pill static">
              <span class="t"><strong>{shortDate(r.day)}</strong></span>
              <span class="v"><span class="dl quiet">{r.d != null && r.d !== 0 ? signed(r.d) : ''}</span><span class="kgv">{fmt1(r.kg)} {t('kg')}</span></span>
            </li>
          {/each}
        </ul>
      </section>
    </aside>
  {/if}
  </div>
</div>

<style>
  .ranges { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip.small { min-height: 36px; padding: 0 14px; font-size: 13px; }
  .entry { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
  .entry .field { flex: 1; }
  .body { order: 3; flex-basis: 100%; display: flex; gap: 10px; }
  .body .field { min-width: 0; }
  .card { background: var(--green); color: #fff; border-radius: 36px 36px 36px 12px; padding: 20px 22px; }
  .kpi { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; }
  .kpi > div { display: flex; flex-direction: column; gap: 2px; }
  .lab { color: #d5ead0; }
  .val { font-family: var(--f-display); font-weight: 800; font-size: 44px; letter-spacing: -0.04em; line-height: 1; }
  .val small { font-family: var(--f-mono); font-size: 14px; font-weight: 500; letter-spacing: 0; }
  .reading { margin-top: 14px; padding-top: 12px; border-top: 1px solid rgb(255 255 255 / 0.22); display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
  .reading p { margin: 0; font-size: 14px; line-height: 1.45; }
  .pace { background: #c9f04a; color: #17211c; border-radius: 999px; padding: 2px 10px; font-size: 13px; font-weight: 700; }
  .unusual { background: #ffcf9e; color: #17211c; border-radius: 999px; padding: 1px 8px; font-weight: 600; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
  .chg { align-items: flex-end; font-family: var(--f-mono); font-weight: 600; font-size: 16px; }
  figure { margin: 0; background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 14px 10px 12px; display: flex; flex-direction: column; gap: 6px; }
  figcaption { padding-left: 8px; }
  .main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .cols { display: flex; flex-direction: column; gap: 12px; }
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .tile { min-height: 112px; color: var(--on-tile); padding: 14px 16px; display: flex; flex-direction: column; justify-content: space-between; gap: 10px; }
  .tl { font-size: 13px; font-weight: 600; }
  .tv { font-size: 40px; line-height: 1; letter-spacing: -0.04em; white-space: nowrap; }
  .tv .unit { font-size: 13px; letter-spacing: 0; }
  .btiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 10px; }
  .btile { color: var(--on-tile); padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .btile .tv { font-size: 34px; }
  .bch { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  .bch > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .bd { font-size: 11px; overflow-wrap: anywhere; }
  .bv { font-size: 14px; font-weight: 600; white-space: nowrap; }
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .stats > div { background: var(--paper); border-radius: 24px 24px 24px 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
  .sv { font-size: 30px; line-height: 1; letter-spacing: -0.04em; }
  .sv small { font-family: var(--f-mono); font-size: 12px; font-weight: 500; letter-spacing: 0; }
  .log { display: flex; flex-direction: column; gap: 8px; }
  .row-pill.static { min-height: 46px; }
  .row-pill .v { display: flex; gap: 18px; align-items: baseline; }
  .dl { font-size: 13px; font-weight: 500; min-width: 3ch; text-align: right; }
  .kgv { min-width: 7ch; text-align: right; }
  .row-pill .t strong { font-size: 14px; }
  /* very narrow (200 % zoom): fields and figures wrap onto their own lines */
  @media (max-width: 299px) {
    .entry .field, .body .field { flex: 1 1 100%; }
    .body { flex-wrap: wrap; }
    .card { padding: 16px 14px; }
    .kpi { flex-wrap: wrap; }
    .val { font-size: 36px; }
    .tiles, .stats { grid-template-columns: minmax(0, 1fr); }
    .tv { white-space: normal; overflow-wrap: anywhere; }
    .bv { white-space: normal; }
    .row-pill .v { flex-wrap: wrap; gap: 2px 12px; }
  }
  @media (min-width: 1280px) {
    .cols { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(340px, 1fr); gap: 28px; align-items: start; }
    .card { padding: 26px 30px; border-radius: 44px 44px 44px 14px; }
    .val { font-size: 64px; }
    .chg { font-size: 20px; }
    figure { padding: 22px 22px 16px; }
  }
  @media (min-width: 1800px) { .cols { grid-template-columns: minmax(0, 1.5fr) minmax(420px, 1fr); gap: 36px; } }
</style>
