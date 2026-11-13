<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, inputNumber, parseNumber, t } from '../lib/i18n';
  import { isPortionEntry, isPortionFood, PORTION_GRAMS } from '../lib/portion';
  import { changed, toast, ui, type AmountRequest } from '../lib/store.svelte';
  import { MEALS, type Meal } from '../lib/types';
  import Sheet from './Sheet.svelte';

  let { req }: { req: AmountRequest } = $props();

  // the sheet is re-created for every request ({#key} in App), so reading `req` once is intended
  // svelte-ignore state_referenced_locally
  const food = req.food;
  // svelte-ignore state_referenced_locally
  const entry = req.entry;
  const unit = (food?.unit ?? entry?.unit ?? 'g') as 'g' | 'ml';
  const title = (food?.name ?? entry?.name) || '?';
  const brand = food?.brand ?? entry?.brand ?? null;
  // a Cookidoo recipe is stored as 100 g = 1 portion: here it is typed, shown and booked as portions
  const byPortion = isPortionFood(food) || isPortionEntry(entry);
  const scale = byPortion ? PORTION_GRAMS : 1;
  const toBooked = (v: number) => Math.round(v * scale * 1000) / 1000;

  // nutrients per 100 g/ml (for an existing entry derived from its scaled values)
  const per = (key: 'kcal' | 'protein' | 'carbs' | 'fat'): number | null => {
    if (food) return food.per_100[key];
    const v = entry?.[key];
    return v == null || !entry || entry.amount <= 0 ? null : (v / entry.amount) * 100;
  };
  const p100 = { kcal: per('kcal'), protein: per('protein'), carbs: per('carbs'), fat: per('fat') };

  // svelte-ignore state_referenced_locally
  let last = $state<number | null>(req.lastAmount == null ? null : req.lastAmount / scale);
  // svelte-ignore state_referenced_locally
  let text = $state(byPortion ? inputNumber(entry ? entry.amount / scale : (req.amount ?? scale) / scale) : inputNumber(entry?.amount ?? req.amount ?? food?.serving_quantity ?? 100));
  // svelte-ignore state_referenced_locally
  let meal = $state<Meal>(req.meal);
  let saving = $state(false);
  let error = $state('');
  let confirming = $state(false);

  const amount = $derived(parseNumber(text));
  const valid = $derived(amount != null && !Number.isNaN(amount) && amount > 0 && toBooked(amount) <= 5000);
  const calc = (v: number | null) => (v == null || !valid ? null : (v * toBooked(amount as number)) / 100);
  const kcal = $derived(calc(p100.kcal));

  onMount(async () => {
    if (!food || last != null) return;
    try {
      const recent = await api.recent(50);
      const found = recent.find((r) => r.food.id === food.id)?.last_amount;
      last = found == null ? null : found / scale;
    } catch { /* the quick pick is optional */ }
  });

  const quick = $derived.by(() => {
    const list: { label: string; value: number }[] = [];
    if (byPortion) {
      list.push({ label: t('halfPortion'), value: 0.5 }, { label: t('portions1'), value: 1 }, { label: t('portionsN', { n: '2' }), value: 2 });
      if (last != null && !list.some((q) => q.value === last)) list.push({ label: t('lastTime', { amount: t('portionsN', { n: fmt(last, 2) }) }), value: last });
      return list;
    }
    if (food?.serving_quantity) list.push({ label: t('portion', { s: `${fmt(food.serving_quantity, 1)} ${unit}` }), value: food.serving_quantity });
    list.push({ label: t('hundred', { unit }), value: 100 });
    if (last != null && !list.some((q) => q.value === last)) list.push({ label: t('lastAmount', { a: fmt(last, 1), unit }), value: last });
    return list;
  });

  const close = () => { ui.amount = null; };
  const failMsg = (err: unknown) => t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });

  async function save() {
    if (!valid) { error = t('badAmount'); return; }
    saving = true;
    error = '';
    try {
      if (entry) {
        await api.patchEntry(entry.id, { amount: toBooked(amount as number), meal });
        toast(t('changed'));
      } else if (food) {
        await api.addEntry(req.day, { food_id: food.id, meal, amount: toBooked(amount as number) });
        toast(t('added', { name: title }));
      }
      ui.amount = null;
      changed();
    } catch (err) {
      error = failMsg(err);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!entry) return;
    if (!confirming) { confirming = true; return; }
    saving = true;
    try {
      await api.deleteEntry(entry.id);
      toast(t('deleted'));
      ui.amount = null;
      changed();
    } catch (err) {
      error = failMsg(err);
      confirming = false;
    } finally {
      saving = false;
    }
  }
</script>

<Sheet title={entry ? t('amountEdit') : t('amount')} onclose={close} label={title}>
  <div class="who">
    <h3>{title}</h3>
    <p class="note">{[brand, p100.kcal != null ? t(byPortion ? 'perPortionShort' : 'per100Short', { kcal: fmt(p100.kcal, 0), unit }) : null].filter(Boolean).join(' · ')}</p>
  </div>

  <div class="meals" role="group" aria-label={t('meal')}>
    {#each MEALS as m}
      <button class="chip" class:on={meal === m} aria-pressed={meal === m} onclick={() => (meal = m)}>{t(m)}</button>
    {/each}
  </div>

  <div class="amountrow">
    <label class="field grow">
      <span>{byPortion ? t('portionsLabel') : `${t('amount')} (${unit})`}</span>
      <input inputmode="decimal" autocomplete="off" bind:value={text} aria-invalid={!valid && text !== ''}
        onfocus={(e) => e.currentTarget.select()} onkeydown={(e) => e.key === 'Enter' && save()} />
    </label>
  </div>
  <div class="quick">
    {#each quick as q}
      <button class="chip" class:on={amount === q.value} onclick={() => (text = inputNumber(q.value))}>{q.label}</button>
    {/each}
  </div>

  <div class="result" aria-live="polite">
    <span class="big display">{kcal == null ? '–' : fmt(Math.round(kcal))}<span class="mono unit"> kcal</span></span>
    <span class="macros mono">
      <span>{t('protein')} {calc(p100.protein) == null ? '–' : fmt(calc(p100.protein) as number, 1)}</span> ·
      <span>{t('carbs')} {calc(p100.carbs) == null ? '–' : fmt(calc(p100.carbs) as number, 1)}</span> ·
      <span>{t('fat')} {calc(p100.fat) == null ? '–' : fmt(calc(p100.fat) as number, 1)} g</span>
    </span>
  </div>
  {#if p100.kcal == null}<p class="note warn">{t('noEnergy')}</p>{/if}
  {#if error}<p class="note warn" role="alert">{error}</p>{/if}

  <button class="btn primary" onclick={save} disabled={saving}>{entry ? t('saveChange') : t('saveToDiary')}</button>
  {#if entry}
    <button class="btn danger" onclick={remove} disabled={saving}>{confirming ? t('confirmDelete') : t('deleteEntry')}</button>
  {/if}
</Sheet>

<style>
  .who h3 { font-size: 18px; font-weight: 600; line-height: 1.2; }
  .meals { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; flex-shrink: 0; }
  .meals .chip { justify-content: center; }
  .quick { display: flex; flex-wrap: wrap; gap: 8px; }
  .grow { flex: 1; }
  .result { background: var(--deep); color: var(--on-deep); border-radius: 28px 28px 28px 8px; padding: 16px 20px; display: flex; flex-direction: column; gap: 4px; }
  .big { font-size: 44px; line-height: 1; }
  .unit { margin-left: 6px; font-size: 14px; font-weight: 500; letter-spacing: 0; }
  .macros { font-size: 12px; color: #cfd6cc; }
  .macros span { white-space: nowrap; }
</style>
