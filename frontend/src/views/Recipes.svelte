<script lang="ts">
  import { tick, untrack } from 'svelte';
  import ActionMenu from '../components/ActionMenu.svelte';
  import CookidooPane from '../components/CookidooPane.svelte';
  import FoodPanel from '../components/FoodPanel.svelte';
  import GroupAssign from '../components/GroupAssign.svelte';
  import GroupChips from '../components/GroupChips.svelte';
  import GroupManager from '../components/GroupManager.svelte';
  import Icon from '../components/Icon.svelte';
  import RecipeThumb from '../components/RecipeThumb.svelte';
  import SearchField from '../components/SearchField.svelte';
  import Sheet from '../components/Sheet.svelte';
  import Suggestions from '../components/Suggestions.svelte';
  import WebRecipePane from '../components/WebRecipePane.svelte';
  import { api, ApiError } from '../lib/api';
  import { cookRun, onRunFinished, refreshRun } from '../lib/cookidooRun.svelte';
  import { fmt, lang, t } from '../lib/i18n';
  import { media, wide } from '../lib/media.svelte';
  import { portionsText, sourceLabel } from '../lib/portion';
  import { router, setQuery } from '../lib/router.svelte';
  import { mealByTime, openAmount, openRecipe, toast, ui } from '../lib/store.svelte';
  import type { Food, Recipe, RecipeGroup } from '../lib/types';

  // Recipes have their own page (they used to be a tab of Products). The list is shared by the household and mixes the household's own
  // recipes (ingredients with amounts) with recipes taken over from Cookidoo. Those are foods of source `cookidoo` (the values of one
  // portion, no ingredients: Cookidoo's texts are not stored) and are marked as such. Wide windows put the selected entry's values beside the
  // list, narrow ones open the editor (own recipe) or a sheet with the values (Cookidoo).
  // Recipes taken over from a web page (source `web`, the host as its label) are the same kind of food: values per portion, a link, no editor.
  // Groups sort the list: chips above it filter (the choice is in the address as ?group=<id> or ?group=none), a recipe of either kind can be in
  // several groups (the members are food ids). A long list (after "take over everything") shows 20 rows at a time, then "Show 20 more"; search, group filter and the count run over all recipes.
  // Taking over a recipe: the "Take over" menu in the head (a "+" menu with "New recipe" on a phone) opens the Cookidoo or the link dialog.
  interface Item { key: string; name: string; kcal: number | null; portions: number | null; recipe: Recipe | null; food: Food; gids: number[] }
  const PAGE = 20;
  let recipes = $state<Recipe[] | null>(null);
  let taken = $state<Food[]>([]);
  let groups = $state<RecipeGroup[]>([]);
  let query = $state('');
  let error = $state('');
  let token = 0;

  async function load() {
    const mine = ++token;
    try {
      const [list, cook, web, grouped] = await Promise.all([
        api.recipes(), api.foods('', 1000, { source: 'cookidoo' }), api.foods('', 1000, { source: 'web' }), api.recipeGroups(),
      ]);
      if (mine !== token) return;
      recipes = list;
      taken = [...cook, ...web];
      groups = grouped;
      error = '';
    } catch (err) {
      if (mine === token) error = t('loadFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    }
  }
  $effect(() => { ui.version; untrack(() => { void load(); }); });

  const items = $derived.by(() => {
    if (!recipes) return null;
    const memberOf = new Map<number, number[]>();
    for (const g of groups) for (const id of g.food_ids) memberOf.set(id, [...(memberOf.get(id) ?? []), g.id]);
    const own: Item[] = recipes.map((r) => ({ key: `r${r.id}`, name: r.food.name ?? '?', kcal: r.kcal_per_portion, portions: r.portions, recipe: r, food: r.food, gids: memberOf.get(r.food.id) ?? [] }));
    const cook: Item[] = taken.map((f) => ({ key: `f${f.id}`, name: f.name ?? '?', kcal: f.per_100.kcal, portions: f.portions ?? null, recipe: null, food: f, gids: memberOf.get(f.id) ?? [] }));
    return [...own, ...cook].sort((x, y) => x.name.localeCompare(y.name, lang));
  });

  // a column of small pictures appears once any recipe has one (until then the list looks as it always did); rows without get a quiet stand-in
  const hasImages = $derived((items ?? []).some((i) => !!i.food.image?.hash));
  async function photoChanged(food: Food) {
    if (sheet?.id === food.id) sheet = food;
    await load();
  }

  // the group filter: 'all', 'none' or a group id (as text), from the address
  const active = $derived.by(() => {
    const g = router.query.get('group');
    return g === 'none' ? 'none' : g && groups.some((x) => String(x.id) === g) ? g : 'all';
  });
  $effect(() => { if (recipes && router.query.get('group') && active === 'all') untrack(() => setQuery({})); }); // a group that is gone
  const pickGroup = (value: string) => { setQuery(value === 'all' ? {} : { group: value }); selected = null; };
  const counts = $derived.by(() => {
    const n = new Map<number, number>();
    let none = 0;
    for (const i of items ?? []) { if (i.gids.length === 0) none++; for (const g of i.gids) n.set(g, (n.get(g) ?? 0) + 1); }
    return { n, none };
  });
  const chips = $derived([
    { value: 'all', label: t('grpAll'), n: items?.length ?? 0 },
    ...groups.map((g) => ({ value: String(g.id), label: g.name, n: counts.n.get(g.id) ?? 0, auto: g.auto })),
    ...(groups.length > 0 ? [{ value: 'none', label: t('grpNone'), n: counts.none }] : []),
  ]);
  const activeGroup = $derived(groups.find((g) => String(g.id) === active) ?? null);

  // the server has no recipe search: filter by group, then by name and ingredient names, here
  const shown = $derived.by(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!items) return items;
    const inGroup = active === 'all' ? items : active === 'none' ? items.filter((i) => i.gids.length === 0) : items.filter((i) => i.gids.includes(Number(active)));
    if (!q) return inGroup;
    return inGroup.filter((i) => i.name.toLocaleLowerCase().includes(q) || (i.recipe?.items.some((x) => x.name.toLocaleLowerCase().includes(q)) ?? false));
  });
  let limit = $state(PAGE);
  $effect(() => { active; query; untrack(() => { limit = PAGE; }); });
  const visible = $derived((shown ?? []).slice(0, limit));
  const countText = $derived(
    !shown || shown.length === 0 ? t('recipesNone')
      : activeGroup ? t('grpRecipesIn', { n: fmt(shown.length), name: activeGroup.name })
      : active === 'none' ? t('grpRecipesNoGroup', { n: fmt(shown.length) })
      : t('recipesCount', { n: fmt(shown.length) }),
  );

  // select several recipes and put them into a group (or take them out of the open one)
  let selecting = $state(false);
  let picked = $state<Set<number>>(new Set());
  let pickingGroup = $state(false);
  const togglePick = (id: number) => { const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id); picked = next; };
  const stopSelecting = () => { selecting = false; picked = new Set(); };
  async function addPicked(group: RecipeGroup) {
    const ids = [...picked];
    try { await api.addToRecipeGroup(group.id, ids); toast(t('grpAdded', { n: fmt(ids.length), name: group.name })); pickingGroup = false; stopSelecting(); await load(); }
    catch (err) { toast(t('grpFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' })); }
  }
  async function createAndAddPicked() {
    const n = newGroup.trim();
    if (!n) return;
    try { const made = await api.createRecipeGroup(n); await addPicked(made); newGroup = ''; }
    catch (err) { toast(err instanceof ApiError && err.status === 409 ? t('grpTaken') : t('grpFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' })); }
  }
  async function removePicked() {
    if (!activeGroup) return;
    const ids = [...picked];
    try { await api.removeFromRecipeGroup(activeGroup.id, ids); toast(t('grpRemoved', { n: fmt(ids.length), name: activeGroup.name })); stopSelecting(); await load(); }
    catch (err) { toast(t('grpFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' })); }
  }
  let newGroup = $state('');
  let managing = $state(false);

  let selected = $state<string | null>(null);
  let sheet = $state<Food | null>(null); // narrow windows: the values of a Cookidoo recipe
  let taking = $state(false); // the "take over from Cookidoo" sheet
  let linking = $state(false); // the "take over from a link" sheet
  const current = $derived(shown?.find((i) => i.key === selected) ?? shown?.[0] ?? null);
  const pick = (i: Item) => {
    if (wide.on) selected = i.key;
    else if (i.recipe) openRecipe({ recipe: i.recipe });
    else sheet = i.food;
  };
  const log = (food: Food) => openAmount({ food, meal: mealByTime(), day: ui.day });
  const portions = (i: Item) => (i.portions == null ? '' : portionsText(i.portions));
  const phone = media('(max-width: 899px)');
  const cookidoo = $derived(ui.me?.features?.cookidoo === true);
  const webRecipes = $derived(ui.me?.features?.web_recipes === true);
  const ways = $derived([
    ...(cookidoo ? [{ key: 'cookidoo', label: t('fromCookidoo'), icon: 'pot' as const, onselect: () => (taking = true) }] : []),
    ...(webRecipes ? [{ key: 'web', label: t('fromWeb'), icon: 'bookmark' as const, onselect: () => (linking = true) }] : []),
  ]);
  const pickFood = (food: Food) => { const i = items?.find((x) => x.food.id === food.id); if (i) pick(i); };

  const why = (err: unknown) => (err instanceof ApiError && typeof err.detail === 'string' ? err.detail : err instanceof ApiError ? String(err.status || err.message) : 'error');
  async function reload(food: Food) {
    try {
      const fresh = food.source === 'web' ? await api.webRecipeReload(food.id) : await api.cookidooAdopt((food.external_id ?? '').replace(/^cookidoo:/, ''), undefined, true);
      if (sheet?.id === food.id) sheet = fresh;
      await load();
      toast(t('cdReloaded'));
    } catch (err) { toast(t('cdReloadFailed', { reason: why(err) })); }
  }
  async function remove(food: Food) {
    try {
      await api.deleteFood(food.id);
      sheet = null;
      selected = null;
      await load();
      toast(t('cdRemoved', { name: food.name ?? '?' }));
    } catch (err) { toast(t('cdFailed', { reason: why(err) })); }
  }
  // a run that takes over many recipes: the list reloads when it ends; while it runs a slim banner says so (and opens the dialog)
  $effect(() => {
    if (!cookidoo) return;
    void refreshRun();
    return onRunFinished(() => { void load(); });
  });
  const ownFromLink = (draft: { name: string; portions: number | null; ingredients: string[]; host: string }) => { linking = false; openRecipe({ recipe: null, draft }); };
  const runBanner = $derived(cookRun.run?.state === 'running' && !taking ? cookRun.run : null);

  async function adopted(food: Food) {
    taking = false;
    linking = false;
    query = '';
    await load();
    selected = `f${food.id}`;
    await tick();
    let at = (shown ?? []).findIndex((i) => i.key === selected);
    if (at < 0 && active !== 'all') { setQuery({}); await tick(); await tick(); at = (shown ?? []).findIndex((i) => i.key === selected); }
    if (at >= limit) limit = Math.ceil((at + 1) / PAGE) * PAGE; // the new recipe is in view even with the short list
    toast(t('cdTakenOver', { name: food.name ?? '?' }));
    await tick();
    document.querySelector(`[data-key="f${food.id}"]`)?.scrollIntoView({ block: 'center' });
  }
</script>

<div class="page split">
  <div class="page-head">
    <h1>{t('recipesTitle')}</h1>
    <div class="actions">
      {#if phone.on && ways.length > 0}
        <ActionMenu tone="lime" icon="plus" aria={t('addMenu')} testid="add-menu"
          items={[{ key: 'new', label: t('addMenuNew'), icon: 'plus', onselect: () => openRecipe({ recipe: null }) }, ...ways]} />
      {:else}
        <button class="btn lime" onclick={() => openRecipe({ recipe: null })} aria-label={t('newRecipe')}>
          <Icon name="plus" size={18} stroke={2.6} /><span class="long">{t('newRecipe')}</span><span class="short">{t('newShort')}</span>
        </button>
        {#if ways.length === 1}
          <button class="btn" data-testid="take-direct" onclick={ways[0].onselect}>{ways[0].label}</button>
        {:else if ways.length > 1}
          <ActionMenu label={t('addTake')} aria={t('addTakeAria')} items={ways} testid="take-menu" />
        {/if}
      {/if}
    </div>
  </div>

  <div class="cols" class:solo={items?.length === 0 && groups.length === 0}>
  <div class="list">
    {#if error}<p class="note warn">{error}</p>{/if}
    {#if runBanner}
      <div class="banner" role="status" data-testid="bulk-banner">
        <span>{t(runBanner.mode === 'pictures' ? 'cbBannerPictures' : 'cbBanner', { done: fmt(runBanner.done), total: fmt(runBanner.total) })}</span>
        <button type="button" class="btn small" onclick={() => (taking = true)}>{t('cbBannerShow')}</button>
      </div>
    {/if}
    {#if items && items.length === 0 && groups.length === 0}
      <section class="invite" aria-labelledby="rec-empty">
        <span class="mark" aria-hidden="true"><Icon name="pot" size={34} stroke={2} /></span>
        <h2 id="rec-empty" class="display">{t('recipesEmptyTitle')}</h2>
        <p>{t('recipesEmptyText')}</p>
        <button class="btn lime" onclick={() => openRecipe({ recipe: null })}>{t('newRecipe')}</button>
      </section>
    {:else if items}
      <Suggestions day={ui.day} variant="page" group={active === 'all' ? undefined : active} onpick={pickFood} />
      <GroupChips {chips} {active} onpick={pickGroup} onmanage={() => (managing = true)} />
      <SearchField bind:value={query} placeholder={t('recipesSearch')} />
      <div class="meta">
        <p class="note" aria-live="polite">{countText}</p>
        {#if shown && shown.length > 0}
          <button type="button" class="btn quiet-btn small" aria-pressed={selecting} onclick={() => (selecting ? stopSelecting() : (selecting = true))}>{selecting ? t('grpSelectDone') : t('grpSelect')}</button>
        {/if}
      </div>
      {#if selecting}
        <div class="selbar" role="group" aria-label={t('grpSelect')}>
          <span class="cnt" aria-live="polite">{t('grpSelected', { n: fmt(picked.size) })}</span>
          <button type="button" class="btn small" onclick={() => (picked = new Set((shown ?? []).map((i) => i.food.id)))}>{t('grpSelectAllHits', { n: fmt(shown?.length ?? 0) })}</button>
          {#if picked.size > 0}<button type="button" class="btn small" onclick={() => (picked = new Set())}>{t('grpSelectClear')}</button>{/if}
          <button type="button" class="btn lime small" disabled={picked.size === 0} onclick={() => (pickingGroup = true)}>{t('grpAddTo')}</button>
          {#if activeGroup}<button type="button" class="btn small" disabled={picked.size === 0} onclick={removePicked}>{t('grpRemoveFrom', { name: activeGroup.name })}</button>{/if}
        </div>
      {/if}
      <ul class="rows">
        {#each visible as r (r.key)}
          {@const on = wide.on && !selecting && current?.key === r.key}
          <li class="rrow" data-key={r.key}>
            {#if selecting}
              <label class="row-pill sel" class:picked={picked.has(r.food.id)} class:thumbed={hasImages}>
                <input type="checkbox" checked={picked.has(r.food.id)} onchange={() => togglePick(r.food.id)} aria-label={t('grpSelectAria', { name: r.name })} />
                {#if hasImages}<RecipeThumb food={{ ...r.food, name: r.name }} />{/if}
                <span class="t"><strong>{r.name}</strong><small>{#if sourceLabel(r.food)}<span class="tag">{sourceLabel(r.food)}</span>{/if}{portions(r)}</small></span>
                <span class="v per">{r.kcal == null ? '–' : `${fmt(Math.round(r.kcal))} kcal`}<small>{t('perPortion')}</small></span>
              </label>
            {:else}
              <button class="row-pill" class:selected={on} class:thumbed={hasImages} aria-current={on ? 'true' : undefined} onclick={() => pick(r)}>
                {#if hasImages}<RecipeThumb food={{ ...r.food, name: r.name }} />{/if}
                <span class="t">
                  <strong>{r.name}</strong>
                  <small>{#if sourceLabel(r.food)}<span class="tag">{sourceLabel(r.food)}</span>{/if}{portions(r)}</small>
                </span>
                <span class="v per">
                  {r.kcal == null ? '–' : `${fmt(Math.round(r.kcal))} kcal`}
                  <small>{t('perPortion')}</small>
                </span>
              </button>
              <button class="round add" onclick={() => log(r.food)} aria-label={t('recipeLog', { name: r.name })} title={t('recipeLog', { name: r.name })}>
                <Icon name="plus" size={20} stroke={2.4} />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
      {#if shown && shown.length > limit}
        <div class="more">
          <p class="note">{t('grpShown', { a: fmt(limit), b: fmt(shown.length) })}</p>
          <button type="button" class="btn" onclick={() => (limit += PAGE)}>{t('grpMore', { n: fmt(Math.min(PAGE, shown.length - limit)) })}</button>
        </div>
      {/if}
    {/if}
  </div>
  {#if wide.on && items && items.length > 0}
    <aside class="pane" aria-label={t('detailPickRecipe')}>
      {#if current}
        {#key `${current.key}-${current.food.fetched_at}`}
          {#if current.recipe}
            <FoodPanel food={current.food} recipe={current.recipe} onedit={() => openRecipe({ recipe: current.recipe })} onadd={() => log(current.food)} onchanged={photoChanged} />
          {:else}
            <FoodPanel food={current.food} onadd={() => log(current.food)} onchanged={photoChanged}
              onreload={current.food.source === 'web' ? (webRecipes ? () => reload(current.food) : undefined) : cookidoo ? () => reload(current.food) : undefined} onremove={() => remove(current.food)} />
          {/if}
        {/key}
        <GroupAssign foodId={current.food.id} {groups} onchange={load} />
      {:else}
        <p class="note empty">{t('detailPickRecipe')}</p>
      {/if}
    </aside>
  {/if}
  </div>
</div>

{#if sheet}
  {@const food = sheet}
  <Sheet title={sourceLabel(food) ?? 'Cookidoo'} label={food.name ?? 'Cookidoo'} tall onclose={() => (sheet = null)}>
    <FoodPanel {food} onchanged={photoChanged} onadd={() => { sheet = null; log(food); }} onreload={food.source === 'web' ? (webRecipes ? () => reload(food) : undefined) : cookidoo ? () => reload(food) : undefined} onremove={() => remove(food)} />
    <GroupAssign foodId={food.id} {groups} onchange={load} />
  </Sheet>
{/if}
{#if taking}
  <Sheet title={t('cdTitle')} tall onclose={() => (taking = false)}>
    <CookidooPane meal={mealByTime()} day={ui.day} onadopt={adopted} bulk />
  </Sheet>
{/if}
{#if linking}
  <Sheet title={t('wrTitle')} tall onclose={() => (linking = false)}>
    <WebRecipePane onadopt={(food) => adopted(food)} onown={ownFromLink} group={activeGroup?.id ?? null} />
  </Sheet>
{/if}
{#if managing}
  <Sheet title={t('grpManageTitle')} onclose={() => (managing = false)}>
    <GroupManager {groups} onchange={load} />
  </Sheet>
{/if}
{#if pickingGroup}
  <Sheet title={t('grpAddTo')} onclose={() => (pickingGroup = false)}>
    <p class="note">{t('grpPick', { n: fmt(picked.size) })}</p>
    <ul class="rows">
      {#each groups as g (g.id)}
        <li><button type="button" class="row-pill" onclick={() => addPicked(g)}><span class="t"><strong>{g.name}</strong></span><span class="v">{fmt(g.count)}</span></button></li>
      {/each}
    </ul>
    <form class="newg" onsubmit={(e) => { e.preventDefault(); void createAndAddPicked(); }}>
      <label class="field"><span class="sr-only">{t('grpNew')}</span><input bind:value={newGroup} maxlength="60" autocomplete="off" placeholder={t('grpInline')} /></label>
      <button class="btn primary" disabled={!newGroup.trim()}>{t('grpAdd')}</button>
    </form>
  </Sheet>
{/if}

<style>
  .page-head .btn { min-height: 44px; padding: 0 16px; }
  .actions { display: flex; gap: 8px; align-items: center; }
  .short { display: none; }
  @media (max-width: 899px) { .long { display: none; } .short { display: inline; } }
  .list { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .rrow { display: flex; align-items: center; gap: 6px; }
  .rrow .row-pill { flex: 1; min-width: 0; }
  /* with pictures: a fixed 44 px box on the left, so a row is 56 px high with or without one */
  .row-pill.thumbed { padding-left: 6px; min-height: 56px; }
  .row-pill.thumbed .t { flex: 1; }
  @media (max-width: 400px) { .row-pill.thumbed { gap: 10px; padding-right: 14px; } .row-pill.thumbed :global(.thumb) { width: 40px; height: 40px; } }
  .row-pill.selected { box-shadow: inset 0 0 0 2px var(--green-text); }
  .add { background: var(--paper); border: 2px solid var(--hairline); }
  .per { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.15; }
  .per small { font-family: var(--f-body); font-size: 11px; font-weight: 500; color: var(--quiet); }
  .meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; }
  .meta .btn.small, .selbar .btn.small, .banner .btn.small { min-height: 44px; padding: 0 16px; font-size: 14px; }
  .selbar { position: sticky; top: calc(8px + var(--band, 0px)); z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 24px 24px 24px 8px; background: var(--paper); box-shadow: 0 0 0 2px var(--hairline), 0 6px 18px rgba(23, 33, 28, 0.12); }
  .selbar .cnt { font-weight: 600; font-size: 14px; margin-right: auto; }
  .banner { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 8px 6px 18px; border-radius: 28px 28px 28px 8px; background: var(--paper); border: 2px solid var(--green-text); font-size: 14px; font-weight: 600; }
  .row-pill.sel { cursor: pointer; justify-content: flex-start; gap: 12px; }
  .row-pill.sel .t { flex: 1; }
  .row-pill.sel.thumbed { padding-left: 14px; }
  .row-pill.sel.picked { box-shadow: inset 0 0 0 2px var(--green-text); }
  .row-pill.sel input { width: 22px; height: 22px; accent-color: var(--primary); flex-shrink: 0; margin: 0; }
  .rrow { content-visibility: auto; contain-intrinsic-size: auto 56px; }
  .more { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
  .newg { display: flex; gap: 8px; align-items: center; }
  .newg .field { flex: 1; min-width: 0; }
  .newg .btn { min-height: 48px; }
  .pane { display: flex; flex-direction: column; gap: 12px; }
  .tag { font-family: var(--f-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; padding: 1px 6px; margin-right: 6px; border-radius: 8px; background: var(--hairline); color: var(--text); }
  .invite {
    background: var(--paper); border-radius: 36px 36px 36px 12px; padding: 28px 24px 24px; display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
  }
  .mark { width: 64px; height: 64px; border-radius: 22px 22px 22px 8px; background: var(--lime); color: var(--on-lime); display: flex; align-items: center; justify-content: center; }
  .invite h2 { font-size: 30px; line-height: 1.05; letter-spacing: -0.03em; }
  .invite p { font-size: 15px; line-height: 1.45; color: var(--quiet); max-width: 46ch; }
  .invite .btn { margin-top: 6px; }
  @media (min-width: 1280px) {
    .cols { display: grid; grid-template-columns: minmax(360px, 0.85fr) minmax(0, 1.15fr); gap: 28px; align-items: start; }
    .cols.solo { display: block; max-width: 640px; }
    .pane { position: sticky; top: calc(24px + var(--band, 0px)); }
    .empty { padding: 24px; }
  }
  @media (min-width: 1800px) { .cols { grid-template-columns: minmax(420px, 0.7fr) minmax(0, 1.3fr); gap: 36px; } }
</style>
