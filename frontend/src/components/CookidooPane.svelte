<script lang="ts">
  // The "Cookidoo" tab of the add sheet: this week's meal plan and the collections of the shared Cookidoo account (names only,
  // no pictures), a field for a recipe link or id, and "take over": the recipe becomes a food with its values per portion.
  import { onMount, tick, untrack } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { cookRun, duration, refreshRun, runUi, setRun } from '../lib/cookidooRun.svelte';
  import { fmt, t } from '../lib/i18n';
  import { openAmount } from '../lib/store.svelte';
  import type { CookidooBulkPreview, CookidooBulkScope, CookidooCollection, CookidooPicturePreview, CookidooPlanDay, CookidooPreview, CookidooRecipeRef, Food, Meal } from '../lib/types';
  import CookidooRunCard from './CookidooRunCard.svelte';

  // Without `onadopt` a taken-over recipe goes straight to the amount dialog (add sheet); with it the caller decides (recipes page).
  // With `bulk` (the recipes page) a whole collection, the week or everything can be taken over in one go: a background run on the server,
  // asked for with a clear question first (how many, how long), shown with its progress here and in the banner of the page.
  let { meal, day, onadopt, bulk = false }: { meal: Meal; day: string; onadopt?: (food: Food, updated: boolean) => void; bulk?: boolean } = $props();

  let week = $state<CookidooPlanDay[] | null>(null);
  let collections = $state<CookidooCollection[] | null>(null);
  let listError = $state('');
  let loadingCollections = $state(false);
  let ref = $state('');
  let preview = $state<CookidooPreview | null>(null);
  let looking = $state(false);
  let adopting = $state(false);
  let error = $state('');
  let source = $state<string | undefined>(undefined); // the collection a recipe was picked from: it goes into that collection's group

  interface Ask { scope: CookidooBulkScope; collection?: string; name?: string; preview: CookidooBulkPreview | null; error: string; regroup: boolean; starting: boolean }
  let ask = $state<Ask | null>(null);
  let askHead = $state<HTMLElement | null>(null);
  const running = $derived(cookRun.run?.state === 'running');

  // the catch-up for the pictures of recipes taken over before: offered only when the admin switched pictures on and recipes lack one
  let pics = $state<CookidooPicturePreview | null>(null);
  let picAsk = $state(false);
  let picStarting = $state(false);
  let picError = $state('');
  async function loadPics() { try { pics = await api.cookidooImagesPreview(); } catch { pics = null; } }
  $effect(() => { if (bulk) { cookRun.run?.state; untrack(() => { void loadPics(); }); } });
  async function startPics() {
    picStarting = true;
    picError = '';
    try { const run = await api.cookidooImagesStart(); runUi.hidden = 0; setRun(run); picAsk = false; } catch (err) { picError = why(err); } finally { picStarting = false; }
  }

  const why = (err: unknown) =>
    err instanceof ApiError && typeof err.detail === 'string' ? err.detail : t('failed', { reason: err instanceof ApiError ? err.status : 'error' });

  onMount(async () => {
    if (bulk) void refreshRun();
    try { week = await api.cookidooWeek(); } catch (err) { week = []; listError = why(err); }
  });

  async function openAsk(scope: CookidooBulkScope, collection?: string, name?: string) {
    ask = { scope, collection, name, preview: null, error: '', regroup: false, starting: false };
    await tick();
    askHead?.focus();
    try {
      const preview = await api.cookidooImportPreview(scope, collection);
      if (ask) ask.preview = preview;
    } catch (err) { if (ask) ask.error = why(err); }
  }
  async function startRun() {
    if (!ask?.preview || ask.starting) return;
    ask.starting = true;
    try {
      const run = await api.cookidooImportStart(ask.scope, ask.collection, ask.regroup);
      runUi.hidden = 0;
      setRun(run);
      ask = null;
    } catch (err) { if (ask) { ask.error = why(err); ask.starting = false; } }
  }
  const askTitle = (a: Ask) => {
    const n = a.preview ? fmt(a.preview.total) : '…';
    return a.scope === 'all' ? t('cbAskAll', { n }) : a.scope === 'week' ? t('cbAskWeek', { n }) : t('cbAskCollection', { n, name: a.name ?? '' });
  };
  const dismissedNames = (a: Ask) => (a.preview?.groups ?? []).filter((g) => g.dismissed).map((g) => g.name).join(', ');

  async function loadCollections() {
    loadingCollections = true;
    try { collections = await api.cookidooCollections(); listError = ''; } catch (err) { listError = why(err); } finally { loadingCollections = false; }
  }

  async function look(reference: string) {
    const text = reference.trim();
    if (!text || looking) return;
    looking = true;
    error = '';
    preview = null;
    try { preview = await api.cookidooRecipe(text); } catch (err) { error = why(err); } finally { looking = false; }
  }

  async function takeOver() {
    if (!preview || adopting) return;
    adopting = true;
    error = '';
    try {
      const updated = preview.food_id != null;
      const food = await api.cookidooAdopt(preview.id, source);
      if (onadopt) onadopt(food, updated); else openAmount({ food, meal, day });
    } catch (err) { error = why(err); } finally { adopting = false; }
  }

  const planned = $derived((week ?? []).filter((d) => d.recipes.length > 0));
  const pick = (r: CookidooRecipeRef, collection?: string) => { source = collection; ref = r.id; void look(r.id); };
</script>

<div class="cookidoo">
  <form class="lookup" onsubmit={(e) => { e.preventDefault(); source = undefined; void look(ref); }}>
    <label class="field"><span>{t('cookidooRef')}</span>
      <input bind:value={ref} autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="400" placeholder="r59322" />
    </label>
    <button class="btn primary" disabled={looking || !ref.trim()}>{looking ? t('searching') : t('lookup')}</button>
  </form>

  {#if error}<p class="note warn" role="alert">{error}</p>{/if}

  {#if bulk}<CookidooRunCard />{/if}

  {#if ask}
    <section class="ask" aria-labelledby="cb-ask-title" data-testid="bulk-ask">
      <h3 id="cb-ask-title" bind:this={askHead} tabindex="-1">{askTitle(ask)}</h3>
      {#if ask.error}
        <p class="note warn" role="alert">{ask.error}</p>
      {:else if !ask.preview}
        <p class="note">{t('cbChecking')}</p>
      {:else}
        {#if ask.preview.fresh > 0}<p class="note">{t('cbAskFresh', { n: fmt(ask.preview.fresh) })}</p>{/if}
        {#if ask.preview.to_fetch === 0}
          <p class="note">{t('cbAskNothing')}</p>
        {:else}
          <p class="note">{t('cbAskTime', { n: fmt(ask.preview.to_fetch), t: duration(ask.preview.eta_seconds) })}</p>
        {/if}
        {#if ask.scope !== 'week' && ask.preview.groups.length}
          <p class="note">{t('cbAskGroups', { names: ask.preview.groups.filter((g) => !g.dismissed).map((g) => g.name).join(', ') || '–' })}</p>
        {/if}
        {#if dismissedNames(ask)}
          <label class="check"><input type="checkbox" bind:checked={ask.regroup} /><span>{t('cbRegroup', { names: dismissedNames(ask) })}</span></label>
        {/if}
      {/if}
      <div class="acts">
        <button type="button" class="btn lime" onclick={startRun} disabled={!ask.preview || ask.starting || running}>{t('cbStart')}</button>
        <button type="button" class="btn" onclick={() => (ask = null)}>{t('cbBack')}</button>
      </div>
    </section>
  {/if}

  {#if bulk && !ask && !listError}
    <button type="button" class="btn all" onclick={() => openAsk('all')} disabled={running}>{t('cbAllBtn')}</button>
  {/if}

  {#if bulk && !ask && !picAsk && pics?.enabled && pics.total > 0}
    <button type="button" class="btn all" onclick={() => (picAsk = true)} disabled={running} data-testid="pics-btn">{t('cbPicBtn', { n: fmt(pics.total) })}</button>
  {/if}
  {#if picAsk && pics}
    <section class="ask" aria-labelledby="cb-pic-title" data-testid="pics-ask">
      <h3 id="cb-pic-title">{t('cbPicAsk', { n: fmt(pics.total) })}</h3>
      <p class="note">{pics.to_fetch > 0 ? t('cbPicTime', { n: fmt(pics.to_fetch), t: duration(pics.eta_seconds) }) : t('cbPicNoCalls', { t: duration(pics.eta_seconds) })}</p>
      {#if picError}<p class="note warn" role="alert">{picError}</p>{/if}
      <div class="acts">
        <button type="button" class="btn lime" onclick={startPics} disabled={picStarting || running}>{t('cbStart')}</button>
        <button type="button" class="btn" onclick={() => (picAsk = false)}>{t('cbBack')}</button>
      </div>
    </section>
  {/if}

  {#if preview}
    <section class="preview" aria-label={preview.name}>
      <h3>{preview.name}</h3>
      <p class="mono vals">
        {fmt(Math.round(preview.per_portion.kcal ?? 0))} kcal ·
        {t('protein')} {preview.per_portion.protein == null ? '–' : fmt(preview.per_portion.protein, 1)} ·
        {t('carbs')} {preview.per_portion.carbs == null ? '–' : fmt(preview.per_portion.carbs, 1)} ·
        {t('fat')} {preview.per_portion.fat == null ? '–' : fmt(preview.per_portion.fat, 1)} g
      </p>
      <p class="note">{t('cookidooPerPortion')}{preview.portions ? ` · ${t('cookidooMakes', { n: fmt(preview.portions, 1) })}` : ''}</p>
      {#if !preview.complete}<p class="note warn">{t('cookidooIncomplete')}</p>{/if}
      <button class="btn lime" onclick={takeOver} disabled={adopting}>{onadopt ? (preview.food_id ? t('cdUpdateOnly') : t('cdTakeOverOnly')) : (preview.food_id ? t('cookidooUpdate') : t('cookidooTakeOver'))}</button>
    </section>
  {/if}

  {#if listError}<p class="note warn" role="alert">{listError}</p>{/if}

  <div class="head">
    <h2 class="micro quiet">{t('cookidooWeek')}</h2>
    {#if bulk && planned.length > 0 && !ask}<button type="button" class="btn small" onclick={() => openAsk('week')} disabled={running}>{t('cbWeekBtn')}</button>{/if}
  </div>
  {#if week === null}
    <p class="note">{t('searching')}</p>
  {:else if planned.length === 0 && !listError}
    <p class="note">{t('cookidooWeekEmpty')}</p>
  {:else}
    {#each planned as d (d.day)}
      <p class="day">{d.title || d.day}</p>
      <ul class="rows">
        {#each d.recipes as r (r.id)}
          <li><button class="row-pill" onclick={() => pick(r)}><span class="t"><strong>{r.name}</strong></span></button></li>
        {/each}
      </ul>
    {/each}
  {/if}

  <h2 class="micro quiet">{t('cookidooCollections')}</h2>
  {#if collections === null}
    <button class="btn" onclick={loadCollections} disabled={loadingCollections}>{loadingCollections ? t('searching') : t('cookidooLoadCollections')}</button>
  {:else if collections.length === 0}
    <p class="note">{t('cookidooCollectionsEmpty')}</p>
  {:else}
    {#each collections as c (c.id)}
      <details>
        <summary>{c.name} <small>({fmt(c.recipes.length)})</small></summary>
        {#if bulk && c.recipes.length > 0 && !ask}
          <button type="button" class="btn small take" onclick={() => openAsk('collection', c.id, c.name)} disabled={running}>{t('cbCollBtn', { n: fmt(c.recipes.length) })}</button>
        {/if}
        <ul class="rows">
          {#each c.recipes as r (r.id)}
            <li><button class="row-pill" onclick={() => pick(r, c.id)}><span class="t"><strong>{r.name}</strong></span></button></li>
          {/each}
        </ul>
      </details>
    {/each}
  {/if}
  <p class="note">{t('cookidooShared')}</p>
</div>

<style>
  .cookidoo { display: flex; flex-direction: column; gap: 12px; }
  .lookup { display: flex; flex-direction: column; gap: 8px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; }
  .btn.small { min-height: 44px; padding: 0 16px; font-size: 14px; }
  .all { align-self: flex-start; }
  .take { margin: 0 8px 8px; }
  .ask { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; border: 2px solid var(--lime); }
  .ask h3 { font-size: 18px; font-weight: 600; line-height: 1.2; outline: none; }
  .ask h3:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; border-radius: 4px; }
  .acts { display: flex; gap: 8px; flex-wrap: wrap; }
  .preview { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; }
  .preview h3 { font-size: 18px; font-weight: 600; line-height: 1.2; }
  .vals { font-size: 13px; }
  .day { font-weight: 600; font-size: 14px; margin-top: 4px; }
  details { background: var(--paper); border-radius: 20px; padding: 4px 8px; }
  summary { min-height: 44px; display: flex; align-items: center; gap: 6px; font-weight: 600; cursor: pointer; padding: 0 8px; }
  summary small { color: var(--quiet); font-weight: 500; }
  details .rows { padding-bottom: 8px; max-height: 40vh; overflow-y: auto; }
</style>
