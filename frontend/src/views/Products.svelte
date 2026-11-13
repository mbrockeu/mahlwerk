<script lang="ts">
  import { untrack } from 'svelte';
  import FoodPanel from '../components/FoodPanel.svelte';
  import FoodRow from '../components/FoodRow.svelte';
  import Icon from '../components/Icon.svelte';
  import SearchField from '../components/SearchField.svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, t } from '../lib/i18n';
  import { wide } from '../lib/media.svelte';
  import { mealByTime, openAmount, openEditor, ui } from '../lib/store.svelte';
  import type { Food } from '../lib/types';

  let query = $state('');
  let foods = $state<Food[] | null>(null);
  let error = $state('');
  let timer = 0;
  let token = 0;

  async function load() {
    const mine = ++token;
    try {
      // recipes (own and from Cookidoo) have their own page
      const list = await api.foods(query.trim(), 200, { exclude: ['recipe', 'cookidoo', 'web'] });
      if (mine !== token) return;
      foods = list;
      error = '';
    } catch (err) {
      if (mine === token) error = t('loadFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    }
  }
  $effect(() => { ui.version; untrack(() => { void load(); }); });
  const onInput = () => { clearTimeout(timer); timer = window.setTimeout(load, 200); };
  // wide windows: a click selects (the values show on the right); narrow ones open the editor as before
  let selFood = $state<number | null>(null);
  const currentFood = $derived(foods?.find((f) => f.id === selFood) ?? foods?.[0] ?? null);
  const edit = (food: Food) => { if (wide.on) selFood = food.id; else openEditor({ food }); };
  const log = (food: Food) => openAmount({ food, meal: mealByTime(), day: ui.day });
</script>

<div class="page split">
  <div class="page-head">
    <h1>{t('productsTitle')}</h1>
    <button class="btn lime" onclick={() => openEditor({ food: null })} aria-label={t('newProduct')}>
      <Icon name="plus" size={18} stroke={2.6} /><span class="long">{t('newProduct')}</span><span class="short">{t('newShort')}</span>
    </button>
  </div>

  <div class="cols">
  <div class="list">
    {#if error}<p class="note warn">{error}</p>{/if}
    <SearchField bind:value={query} oninput={onInput} />
    {#if foods}
      <p class="note">{foods.length ? t('count', { n: fmt(foods.length) }) : t('none')}</p>
      <ul class="rows">{#each foods as food (food.id)}<FoodRow {food} onpick={edit} selected={wide.on && currentFood?.id === food.id} />{/each}</ul>
    {/if}
  </div>
  {#if wide.on}
    <aside class="pane" aria-label={t('detailPick')}>
      {#if currentFood}
        {#key currentFood.id}<FoodPanel food={currentFood} onedit={() => openEditor({ food: currentFood })} onadd={() => log(currentFood)} />{/key}
      {:else}
        <p class="note empty">{t('detailPick')}</p>
      {/if}
    </aside>
  {/if}
  </div>
  <p class="note credit">{t('credit')} <a href="https://world.openfoodfacts.org" rel="noopener">Open Food Facts</a> (ODbL) · {t('creditBls')}</p>
</div>

<style>
  .credit a { color: var(--green-text); }
  .page-head .btn { min-height: 44px; padding: 0 16px; }
  .short { display: none; }
  @media (max-width: 899px) { .long { display: none; } .short { display: inline; } }
  .list { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .credit { max-width: 70ch; }
  @media (min-width: 1280px) {
    /* list on the left, the selected product's values on the right (kept in view while the list scrolls) */
    .cols { display: grid; grid-template-columns: minmax(360px, 0.85fr) minmax(0, 1.15fr); gap: 28px; align-items: start; }
    .pane { position: sticky; top: calc(24px + var(--band, 0px)); }
    .empty { padding: 24px; }
  }
  @media (min-width: 1800px) { .cols { grid-template-columns: minmax(420px, 0.7fr) minmax(0, 1.3fr); gap: 36px; } }
</style>
