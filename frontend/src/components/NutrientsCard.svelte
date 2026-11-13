<script lang="ts">
  import { untrack } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { directory, ensureNutrients, nutrientName } from '../lib/nutrients.svelte';
  import { CORE_KEYS, normalizePick, pickGroup, refOf, summaryOf, type PickItem, type Ref } from '../lib/nutrientCompare';
  import { t } from '../lib/i18n';
  import type { Granularity, Insights, NutrientCurve } from '../lib/types';
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
  const summaries = $derived(shown.map((k, i) => summaryOf(k, curves[k]?.series ?? [], refs[i], data.micros, data.averages as unknown as Record<string, number>)));
</script>

<NutrientPicker {items} sel={shown.length ? shown : sel} {onsel} />
{#if !ready}<div class="skel short" aria-hidden="true"></div>
{:else if error}<p class="note warn" role="alert">{t('nutLoadFailed', { reason: error })}</p>
{:else if !loaded}<div class="skel short" aria-hidden="true"></div>
{:else if single}
  {#if list[0].has_data}<NutrientChart curve={list[0]} name={nameOf(shown[0])} />{:else}<p class="note">{t('nutNone')}</p>{/if}
{:else if list.every((c) => !c.has_data)}<p class="note">{t('nutNone')}</p>
{:else}<NutrientCompare curves={list} names={shown.map(nameOf)} {refs} {summaries} />{/if}

<style>
  .skel { height: 160px; border-radius: 28px 28px 28px 8px; background: var(--hairline); opacity: 0.5; }
</style>
