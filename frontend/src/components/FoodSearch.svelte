<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { t } from '../lib/i18n';
  import { loadMe, ui } from '../lib/store.svelte';
  import type { CatalogItem, Food } from '../lib/types';
  import FoodRow from './FoodRow.svelte';
  import SearchField from './SearchField.svelte';

  // The search shared by the add sheet and the recipe editor: products stored here, then the basic foods (BLS) and packaged products of the local catalogue.
  let { onpick, onnew, active = true }: { onpick: (food: Food) => void; onnew?: () => void; active?: boolean } = $props();

  let query = $state('');
  let results = $state<Food[]>([]);
  let searching = $state(false);
  let searchError = $state('');
  let timer = 0;
  let searchToken = 0;

  // the local catalogue, shown below the products stored here: basic foods (BLS) first, then packaged products
  let catalogItems = $state<CatalogItem[]>([]);
  const basics = $derived(catalogItems.filter((c) => c.source === 'bls'));
  const packaged = $derived(catalogItems.filter((c) => c.source !== 'bls'));
  let catalogToken = 0;
  let catalogRequest: AbortController | null = null;
  let adopting = $state(false);

  async function runCatalog() {
    const mine = ++catalogToken;
    catalogRequest?.abort(); // a newer keystroke makes the running request obsolete
    const text = query.trim();
    if (text.length < 2 || (ui.me && ui.me.catalog.products === 0 && ui.me.catalog.bls.products === 0)) { catalogItems = []; return; }
    const request = (catalogRequest = new AbortController());
    try {
      const list = await api.catalog(text, 25, request.signal);
      if (mine === catalogToken) catalogItems = list;
    } catch {
      if (mine === catalogToken) catalogItems = []; // the section is an extra: no catalogue, no error message
    }
  }

  async function pickCatalog(item: CatalogItem) {
    if (adopting) return;
    adopting = true;
    try {
      onpick(await api.adoptCatalogItem(item));
    } catch (err) {
      searchError = t('failed', { reason: err instanceof ApiError ? err.status : 'error' });
    } finally {
      adopting = false;
    }
  }

  onDestroy(() => { catalogToken += 1; catalogRequest?.abort(); clearTimeout(timer); });
  if (!ui.me) void loadMe();

  async function runSearch() {
    const mine = ++searchToken;
    void runCatalog();
    searching = true;
    try {
      const list = await api.foods(query.trim(), 50);
      if (mine !== searchToken) return;
      results = list;
      searchError = '';
    } catch (err) {
      if (mine === searchToken) searchError = t('failed', { reason: err instanceof ApiError ? err.status : 'error' });
    } finally {
      if (mine === searchToken) searching = false;
    }
  }
  function onInput() { clearTimeout(timer); timer = window.setTimeout(runSearch, 200); }

  // the first look (the newest products) happens once, when the search is shown for the first time
  let started = false;
  $effect(() => {
    if (active && !started) { started = true; void runSearch(); }
  });
</script>

<div class="search">
<SearchField bind:value={query} oninput={onInput} />
{#if onnew}<button class="btn lime" onclick={onnew}>{t('newProduct')}</button>{/if}
{#if searchError}<p class="note warn">{searchError}</p>{/if}
{#if results.length}
  {#if catalogItems.length}<h2 class="micro quiet">{t('yourProducts')}</h2>{/if}
  <ul class="rows">{#each results as food (food.id)}<FoodRow {food} onpick={onpick} />{/each}</ul>
{:else if !catalogItems.length && !searching && !searchError}
  <p class="note">{t('noResults')}</p>
{/if}
{#if basics.length}
  <h2 class="micro quiet">{t('basicFoods')}</h2>
  <ul class="rows" aria-busy={adopting}>
    {#each basics as item (item.source + item.code)}
      <FoodRow food={item} extra="" onpick={pickCatalog} />
    {/each}
  </ul>
{/if}
{#if packaged.length}
  <h2 class="micro quiet">{t('moreProducts')}</h2>
  <ul class="rows" aria-busy={adopting}>
    {#each packaged as item (item.source + item.code)}
      <FoodRow food={item} extra={item.quantity ?? ''} onpick={pickCatalog} />
    {/each}
  </ul>
{/if}
</div>

<style>
  .search { display: flex; flex-direction: column; gap: 12px; }
</style>
