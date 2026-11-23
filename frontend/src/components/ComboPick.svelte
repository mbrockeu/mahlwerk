<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, t } from '../lib/i18n';
  import { changed, closeAdd, toast } from '../lib/store.svelte';
  import type { Combo, Entry, Meal } from '../lib/types';

  // A favourite combo ("Combos" in the Recent tab) as a checklist inside the add sheet: every food with a checkbox (all on) and its amount from the
  // last time the combo was eaten, changeable. "Add" books the checked ones into the chosen meal of the chosen day, all or nothing, and offers Undo.
  let { combo, meal, day, onback }: { combo: Combo; meal: Meal; day: string; onback: () => void } = $props();

  // svelte-ignore state_referenced_locally
  let on = $state(combo.items.map(() => true));
  // svelte-ignore state_referenced_locally
  let amounts = $state(combo.items.map((i) => String(i.amount)));
  let booking = $state(false);
  let error = $state('');
  let heading: HTMLElement | undefined;

  onMount(() => heading?.focus());

  const amountOf = (i: number) => Number(amounts[i].replace(',', '.'));
  const valid = (i: number) => Number.isFinite(amountOf(i)) && amountOf(i) > 0 && amountOf(i) <= 5000;
  const chosen = $derived(combo.items.map((_, i) => i).filter((i) => on[i]));
  const ready = $derived(chosen.length > 0 && chosen.every(valid));
  const kcal = $derived(chosen.reduce((sum, i) => sum + (valid(i) && combo.items[i].food.per_100.kcal != null ? (combo.items[i].food.per_100.kcal as number) * amountOf(i) / 100 : 0), 0));
  const reason = (err: unknown) => (err instanceof ApiError ? err.status || err.message : 'error');

  async function book() {
    if (booking || !ready) return;
    booking = true;
    error = '';
    const made: Entry[] = [];
    try {
      for (const i of chosen) made.push(await api.addEntry(day, { food_id: combo.items[i].food.id, meal, amount: amountOf(i) }));
    } catch (err) {
      // all or nothing: what was booked a moment ago is taken back, so a second try does not double it
      await Promise.allSettled(made.map((e) => api.deleteEntry(e.id)));
      error = t('visBookFailed', { reason: reason(err) });
      booking = false;
      return;
    }
    closeAdd();
    changed();
    toast(t('comboAdded', { meal: t(meal) }), {
      label: t('undo'),
      run: async () => {
        await Promise.allSettled(made.map((e) => api.deleteEntry(e.id)));
        changed();
        toast(t('undone'));
      },
    });
  }
</script>

<div class="cp">
  <h3 bind:this={heading} tabindex="-1">{t('comboTitle', { meal: t(meal) })}</h3>
  <p class="note">{t('comboNote')}</p>
  <ul class="checks" aria-label={t('comboHeading')}>
    {#each combo.items as item, i}
      <li class="line">
        <label class="check">
          <input type="checkbox" bind:checked={on[i]} disabled={booking} aria-label={t('comboInclude', { name: item.food.name ?? '?' })} />
          <span class="n">{item.food.name ?? '?'}{#if item.food.brand}<small>{item.food.brand}</small>{/if}</span>
        </label>
        <label class="amount">
          <span class="sr-only">{t('comboAmount', { name: item.food.name ?? '?', unit: item.food.unit })}</span>
          <input type="text" inputmode="decimal" bind:value={amounts[i]} disabled={booking || !on[i]} aria-invalid={on[i] && !valid(i) ? 'true' : undefined} />
          <span class="u" aria-hidden="true">{item.food.unit}</span>
        </label>
      </li>
    {/each}
  </ul>
  <p class="note warn" role="status">{error}</p>
  <button class="btn primary" onclick={book} disabled={booking || !ready}>{booking ? t('comboAdding') : t('comboAdd', { n: chosen.length })}{#if ready}{' · '}{fmt(Math.round(kcal))} kcal{/if}</button>
  <button type="button" class="btn quiet-btn" onclick={onback} disabled={booking}>{t('comboBack')}</button>
</div>

<style>
  .cp { display: flex; flex-direction: column; gap: 12px; }
  h3 { font-size: 17px; font-weight: 700; }
  h3:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; border-radius: 6px; }
  .line { display: flex; align-items: center; gap: 8px; }
  .line .check { flex: 1; min-width: 0; }
  .n { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
  .n small { font-size: 12px; color: var(--quiet); font-weight: 500; }
  .amount { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .amount input { width: 74px; min-height: 44px; border-radius: 14px; border: 2px solid var(--hairline); background: var(--stone); padding: 0 10px; text-align: right; font-family: var(--f-mono); font-size: 15px; color: var(--text); }
  .amount input:focus-visible { outline: 3px solid var(--focus); outline-offset: 0; }
  .amount input[aria-invalid='true'] { border-color: var(--warn); }
  .amount input:disabled { opacity: 0.5; }
  .u { font-size: 12px; color: var(--quiet); min-width: 18px; }
</style>
