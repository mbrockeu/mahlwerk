<script lang="ts">
  import { untrack } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { directory, ensureNutrients, nutrientName } from '../lib/nutrients.svelte';
  import { CORE_KEYS, normalizePick, pickGroup, refOf, summaryOf, unitCharts, type PickItem, type Ref } from '../lib/nutrientCompare';
  import { t } from '../lib/i18n';
  import type { Granularity, Insights, NutrientCurve } from '../lib/types';
  import NutrientAxes from './NutrientAxes.svelte';
  import NutrientChart from './NutrientChart.svelte';
  import NutrientCompare from './NutrientCompare.svelte';
  import NutrientPicker from './NutrientPicker.svelte';

  // "Nutrient over time": one to four nutrients chosen as chips. One nutrient is drawn in its own unit, several share an axis in
  // percent of their reference amount. One request per nutrient (the existing endpoint), answers of an older period are dropped.
  let { data, sel, onsel }: { data: Insights; sel: string[]; onsel: (next: string[]) => void } = $props();

  ensureNutrients();
  const gran = $derived<Granularity>(data.granularity ?? 'day');
  const nameOf = (k: string) => ((CORE_KEYS as readonly string[]).includes(k) ? t(k as 'protein') : nutrientName(k));
  const nrvOf = (k: string) => data.micros.find((m) => m.key === k)?.nrv ?? directory.list.find((d) => d.key === k)?.nrv ?? null;
  const ref = (k: string) => refOf(k, data.goal, nrvOf(k));

  const items = $derived.by<PickItem[]>(() => {
    const out = new Map<string, PickItem>();
    for (const k of CORE_KEYS) out.set(k, { key: k, name: nameOf(k), group: 'macro', unit: k === 'kcal' ? 'kcal' : 'g', ref: ref(k) });
    for (const m of data.micros) out.set(m.key, { key: m.key, name: nameOf(m.key), group: pickGroup(m.key, m.group), unit: m.unit, ref: ref(m.key) });
    for (const d of directory.list) if (sel.includes(d.key) && !out.has(d.key)) out.set(d.key, { key: d.key, name: nameOf(d.key), group: pickGroup(d.key, d.group), unit: d.unit, ref: ref(d.key) });
    const list = [...out.values()];
    const order = (i: PickItem) => (i.group === 'macro' ? CORE_KEYS.indexOf(i.key as 'kcal') : 0);
    return list.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  });
  const ready = $derived(directory.list.length > 0);
  // the selection as drawn: a link with a mix of nutrients with and without reference is repaired
  const known = $derived(new Set<string>([...CORE_KEYS, ...directory.list.map((d) => d.key)]));
  const shown = $derived(ready ? normalizePick(sel.filter((k) => known.has(k)), ref) : []);

  let curves = $state<Record<string, NutrientCurve>>({});
  let failed = $state<Record<string, string>>({});
  let context = '';
  let ctrl: AbortController | null = null;
  const pending = new Set<string>();
  $effect(() => {
    const d = data;
    const keys = shown;
    const g = gran;
    if (d.range.logged_days <= 0) return;
    untrack(() => {
      const ctx = `${d.range.from}|${d.range.to}|${g}`;
      if (ctx !== context) { ctrl?.abort(); ctrl = new AbortController(); context = ctx; curves = {}; failed = {}; }
      const signal = (ctrl as AbortController).signal;
      for (const key of keys) {
        if (curves[key] || failed[key] || pending.has(`${ctx}|${key}`)) continue;
        pending.add(`${ctx}|${key}`);
        api.insightsNutrient(key, d.range.from, d.range.to, g, signal).then(
          (c) => { if (ctx === context) curves = { ...curves, [key]: c }; },
          (err) => { if (ctx === context && !signal.aborted) failed = { ...failed, [key]: err instanceof ApiError ? String(err.status || err.message) : 'error' }; },
        ).finally(() => pending.delete(`${ctx}|${key}`));
      }
    });
  });

  const loaded = $derived(shown.every((k) => curves[k]));
  const error = $derived(shown.map((k) => failed[k]).find(Boolean) ?? '');
  const list = $derived(shown.map((k) => curves[k]).filter(Boolean));
  const single = $derived(shown.length === 1);
  const refs = $derived(shown.map((k) => ref(k) as Ref));
  // several nutrients: in their own units on a left and a right axis (default; more than two units make a second chart),
  // or together on one axis in percent of the reference
  const VIEW_KEY = 'mahlwerk.nutView';
  const readView = () => { try { return localStorage.getItem(VIEW_KEY) === 'pct' ? 'pct' : 'units'; } catch { return 'units'; } };
  let view = $state<'units' | 'pct'>(readView());
  function setView(v: 'units' | 'pct') {
    view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: only for this visit */ }
  }
  const charts = $derived(unitCharts(list.map((c) => c.unit)));
  const summaries = $derived(shown.map((k, i) => summaryOf(k, curves[k]?.series ?? [], refs[i], data.micros, data.averages as unknown as Record<string, number>)));
</script>

<NutrientPicker {items} sel={shown.length ? shown : sel} {onsel} />
{#if !ready}<div class="skel short" aria-hidden="true"></div>
{:else if error}<p class="note warn" role="alert">{t('nutLoadFailed', { reason: error })}</p>
{:else if !loaded}<div class="skel short" aria-hidden="true"></div>
{:else if single}
  {#if list[0].has_data}<NutrientChart curve={list[0]} name={nameOf(shown[0])} />{:else}<p class="note">{t('nutNone')}</p>{/if}
{:else if list.every((c) => !c.has_data)}<p class="note">{t('nutNone')}</p>
{:else}
  <div class="seg-ctl" role="group" aria-label={t('nutViewLabel')}>
    <button class="chip" class:on={view === 'units'} aria-pressed={view === 'units'} onclick={() => setView('units')}>{t('nutViewUnits')}</button>
    <button class="chip" class:on={view === 'pct'} aria-pressed={view === 'pct'} onclick={() => setView('pct')}>{t('nutViewPct')}</button>
  </div>
  {#if view === 'pct'}<NutrientCompare curves={list} names={shown.map(nameOf)} {refs} {summaries} />
  {:else}
    {#if charts.length > 1}<p class="note">{t('nutAxesSplit')}</p>{/if}
    {#each charts as ch (ch.left + (ch.right ?? ''))}
      <NutrientAxes curves={list} names={shown.map(nameOf)} refs={shown.map((k) => ref(k))} {summaries} chart={ch} />
    {/each}
    <p class="note keyline"><svg width="26" height="10" aria-hidden="true"><path d="M1 5H25" stroke="var(--quiet)" stroke-width="1.2" stroke-dasharray="2 4" /></svg>{t('nutRefLine')}</p>
  {/if}
{/if}

<style>
  .keyline { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .seg-ctl { display: flex; flex-wrap: wrap; gap: 6px; }
  .seg-ctl .chip { min-height: 40px; padding: 0 14px; font-size: 13px; }
  .skel { height: 160px; border-radius: 28px 28px 28px 8px; background: var(--hairline); opacity: 0.5; }
</style>
