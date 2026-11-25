<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { fmt, t } from '../lib/i18n';
  import { isPortionFood, PORTION_GRAMS, portionsText } from '../lib/portion';
  import { changed, closeAdd, loadMe, loadVision, openAmount, openEditor, toast, ui, visionReady, type AddTab } from '../lib/store.svelte';
  import { MEALS, type Combo, type Entry, type Food, type Meal, type RecentFood, type Template } from '../lib/types';
  import FoodRow from './FoodRow.svelte';
  import FoodSearch from './FoodSearch.svelte';
  import Icon from './Icon.svelte';
  import ComboPick from './ComboPick.svelte';
  import CookidooPane from './CookidooPane.svelte';
  import MealPhoto from './MealPhoto.svelte';
  import ScanPane from './ScanPane.svelte';
  import Sheet from './Sheet.svelte';

  let { meal: initialMeal, day, tab: initialTab, query: initialQuery = '', replace, photo: initialPhoto = false }: { meal: Meal; day: string; tab: AddTab; query?: string; replace?: Entry; photo?: boolean } = $props();

  // svelte-ignore state_referenced_locally
  let meal = $state<Meal>(initialMeal);
  // svelte-ignore state_referenced_locally
  let tab = $state<AddTab>(initialTab);
  // svelte-ignore state_referenced_locally
  let query = $state(initialQuery);
  // kept in ui.add, so that "Back" in the amount dialog brings the sheet back as it was
  $effect(() => { const add = ui.add; if (add) { add.meal = meal; add.tab = tab; add.query = query; add.photo = photo; } });

  if (!ui.me) void loadMe();
  void loadVision();
  // "Photo of the meal" (only where photo recognition is on and ready): it takes over the sheet below the meal chips until the person goes back;
  // a direct link (/?go=photo) opens the sheet on it
  // svelte-ignore state_referenced_locally
  let photo = $state(initialPhoto && !replace);

  // recent: the foods that fit the chosen meal first, and above them the combos the person often eats together in it (not when swapping one entry's food)
  let recent = $state<RecentFood[] | null>(null);
  let combos = $state<Combo[]>([]);
  let loadedFor = $state<Meal | null>(null);
  let combo = $state<Combo | null>(null);
  let savingCombo = $state(false);
  let comboError = $state('');
  let recentToken = 0;
  async function loadRecent(forMeal: Meal) {
    const token = ++recentToken;
    const [list, found] = await Promise.all([
      api.recent(20, forMeal).catch(() => [] as RecentFood[]),
      replace ? Promise.resolve([] as Combo[]) : api.combos(forMeal).catch(() => [] as Combo[]),
    ]);
    if (token !== recentToken) return; // the meal changed meanwhile
    recent = list;
    combos = found;
  }

  // templates
  let templates = $state<Template[] | null>(null);
  let templateError = $state('');
  let menuFor = $state<number | null>(null);
  let renameText = $state('');
  let confirmingDelete = $state(false);
  let applying = $state(false);

  async function loadTemplates() {
    try { templates = await api.templates(); templateError = ''; } catch (err) {
      templates = [];
      templateError = t('failed', { reason: err instanceof ApiError ? err.status : 'error' });
    }
  }

  $effect(() => {
    if (tab === 'recent' && loadedFor !== meal) { loadedFor = meal; void loadRecent(meal); }
    if (tab === 'templates' && templates === null) void loadTemplates();
  });

  const pick = (food: Food, lastAmount?: number) => openAmount({ food, meal, day, lastAmount });
  const newProduct = () => openEditor({ food: null, onSaved: (food) => openAmount({ food, meal, day }) });

  async function applyTemplate(template: Template) {
    if (applying) return;
    applying = true;
    try {
      const { entries } = await api.applyTemplate(template.id, { day, meal });
      closeAdd();
      changed();
      toast(t('templateAdded', { name: template.name }), {
        label: t('undo'),
        run: async () => {
          await Promise.allSettled(entries.map((e) => api.deleteEntry(e.id)));
          changed();
          toast(t('undone'));
        },
      });
    } catch (err) {
      templateError = t('failed', { reason: err instanceof ApiError ? err.status : 'error' });
    } finally {
      applying = false;
    }
  }

  const comboNames = (c: Combo) => c.items.map((i) => i.food.name ?? '?');
  async function saveCombo(c: Combo) {
    if (savingCombo) return;
    savingCombo = true;
    comboError = '';
    const names = comboNames(c).join(' · ');
    const name = names.length > 80 ? `${names.slice(0, 79)}…` : names;
    try {
      await api.createTemplateFromFoods(name, c.items.map((i) => ({ food_id: i.food.id, amount: i.amount })));
      templates = null; // the list reloads when it is opened
      toast(t('comboSaved', { name }));
      void loadRecent(meal); // a combo that is a template now is no longer offered
    } catch (err) {
      comboError = t('comboSaveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      savingCombo = false;
    }
  }

  function openMenu(template: Template) {
    menuFor = menuFor === template.id ? null : template.id;
    renameText = template.name;
    confirmingDelete = false;
  }

  async function rename(template: Template) {
    const name = renameText.trim();
    if (!name || name.length > 80) { templateError = t('templateNameBad'); return; }
    try {
      await api.renameTemplate(template.id, name);
      menuFor = null;
      templateError = '';
      await loadTemplates();
      toast(t('templateRenamed'));
    } catch (err) {
      templateError = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    }
  }

  async function removeTemplate(template: Template) {
    if (!confirmingDelete) { confirmingDelete = true; return; }
    try {
      await api.deleteTemplate(template.id);
      menuFor = null;
      confirmingDelete = false;
      await loadTemplates();
      toast(t('templateDeleted'));
    } catch (err) {
      templateError = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
      confirmingDelete = false;
    }
  }

  const itemsLine = (template: Template) => {
    const names = template.items.map((i) => i.name);
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} …` : names.join(', ');
  };

  // the Cookidoo tab exists only while the admin has the connector switched on
  const tabs = $derived<{ id: AddTab; label: () => string }[]>([
    { id: 'scan', label: () => t('tabScan') },
    { id: 'search', label: () => t('tabSearch') },
    { id: 'recent', label: () => t('tabRecent') },
    // swapping the food of one entry: a template or a meal photo would add several, so they are not offered
    ...(replace ? [] : [{ id: 'templates' as AddTab, label: () => t('tabTemplates') }]),
    ...(ui.me?.features?.cookidoo ? [{ id: 'cookidoo' as AddTab, label: () => t('tabCookidoo') }] : []),
  ]);

  function tabKey(event: KeyboardEvent, i: number) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const next = tabs[(i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
    tab = next;
    (document.getElementById(`tab-${next}`) as HTMLElement | null)?.focus();
  }
</script>

<Sheet title={replace ? t('swapTitle') : t('addTitle')} onclose={closeAdd} tall>
  {#if replace}<p class="note">{t('swapNote', { name: replace.name ?? '?' })}</p>{/if}
  <div class="meals" role="group" aria-label={t('meal')}>
    {#each MEALS as m}
      <button class="chip" class:on={meal === m} aria-pressed={meal === m} onclick={() => (meal = m)}>{t(m)}</button>
    {/each}
  </div>

  {#if photo}
    <MealPhoto {meal} {day} onback={() => (photo = false)} />
  {:else if combo}
    <ComboPick {combo} {meal} {day} onback={() => (combo = null)} />
  {:else}
  <div class="tabs" class:five={tabs.length > 4} role="tablist">
    {#each tabs as item, i}
      <button role="tab" id="tab-{item.id}" aria-selected={tab === item.id} aria-controls="panel-{item.id}" tabindex={tab === item.id ? 0 : -1}
        class:on={tab === item.id} onclick={() => (tab = item.id)} onkeydown={(e) => tabKey(e, i)}>{item.label()}</button>
    {/each}
  </div>

  <div role="tabpanel" id="panel-{tab}" aria-labelledby="tab-{tab}" class="panel">
    {#if tab === 'scan'}
      <ScanPane {meal} {day} />
      {@render photoButton()}
    {:else if tab === 'cookidoo'}
      <CookidooPane {meal} {day} />
    {/if}
    <!-- the search stays mounted while another tab is shown, so the typed text survives a look at "Recent" -->
    {#if tab === 'search'}{@render photoButton()}{/if}
    <div class="pane" hidden={tab !== 'search'}><FoodSearch onpick={(f) => pick(f)} onnew={newProduct} active={tab === 'search'} bind:query /></div>
    {#if tab === 'recent'}
      {#if recent === null}
        <p class="note">{t('searching')}</p>
      {:else if recent.length === 0}
        <p class="note">{t('noRecent')}</p>
      {:else}
        {#if combos.length}
          <h3 class="sub">{t('comboHeading')}</h3>
          {#if comboError}<p class="note warn" role="alert">{comboError}</p>{/if}
          <ul class="rows combos">
            {#each combos as c (c.items.map((i) => i.food.id).join('-'))}
              <li>
                <button class="row-pill" onclick={() => (combo = c)}>
                  <span class="t"><strong>{comboNames(c).join(' · ')}</strong><small>{t('comboDays', { n: c.days })}</small></span>
                  <span class="v">{fmt(Math.round(c.kcal))}<span class="u"> kcal</span></span>
                </button>
                <button class="save" disabled={savingCombo} aria-label={t('comboSaveTplAria', { foods: comboNames(c).join(', ') })} onclick={() => saveCombo(c)}><Icon name="bookmark" size={14} />{t('comboSaveTpl')}</button>
              </li>
            {/each}
          </ul>
          <h3 class="sub">{t('comboSingles')}</h3>
        {/if}
        <ul class="rows">
          {#each recent as r (r.food.id)}
            <FoodRow food={r.food} extra={t('lastTime', { amount: isPortionFood(r.food) ? portionsText(r.last_amount / PORTION_GRAMS) : `${r.last_amount} ${r.food.unit}` })} onpick={(f) => pick(f, r.last_amount)} />
          {/each}
        </ul>
      {/if}
    {:else if tab === 'templates'}
      {#if templateError}<p class="note warn" role="alert">{templateError}</p>{/if}
      {#if templates === null}
        <p class="note">{t('searching')}</p>
      {:else if templates.length === 0}
        <div class="empty">
          <Icon name="bookmark" size={26} />
          <p>{t('templateFirst')}</p>
        </div>
      {:else}
        <ul class="rows tpl">
          {#each templates as template (template.id)}
            <li class:open={menuFor === template.id}>
              <div class="line">
                <button class="row-pill" onclick={() => applyTemplate(template)} disabled={applying}>
                  <span class="t"><strong>{template.name}</strong><small>{itemsLine(template)}</small></span>
                  <span class="v">{fmt(Math.round(template.kcal))}<span class="u"> kcal</span></span>
                </button>
                <button class="round" aria-expanded={menuFor === template.id} aria-label={t('templateOptions', { name: template.name })}
                  onclick={() => openMenu(template)}><Icon name="more" size={22} /></button>
              </div>
              {#if menuFor === template.id}
                <form class="menu" onsubmit={(e) => { e.preventDefault(); void rename(template); }}>
                  <label class="field"><span>{t('templateName')}</span>
                    <input bind:value={renameText} maxlength="80" autocomplete="off" />
                  </label>
                  <div class="menubtns">
                    <button class="btn primary">{t('rename')}</button>
                    <button type="button" class="btn danger" onclick={() => removeTemplate(template)}>{confirmingDelete ? t('confirmDeleteTemplate') : t('delete')}</button>
                  </div>
                </form>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
  {/if}
</Sheet>

{#snippet photoButton()}
  {#if visionReady() && !replace}
    <button type="button" class="btn photo" data-testid="meal-photo" onclick={() => (photo = true)}><Icon name="camera" size={18} />{t('visMealButton')}</button>
  {/if}
{/snippet}

<style>
  .meals { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; flex-shrink: 0; }
  .meals .chip { justify-content: center; }
  .tabs { display: flex; background: var(--paper); border-radius: 26px; padding: 4px; gap: 2px; flex-shrink: 0; }
  .tabs button { flex: 1; min-width: 0; min-height: 44px; padding: 0 4px; border-radius: 22px; font-weight: 600; font-size: 14px; color: var(--quiet); white-space: nowrap; }
  /* very narrow (200 % zoom): meal chips and tabs wrap onto several lines, no label is cut */
  @media (max-width: 299px) {
    .meals { display: flex; flex-wrap: wrap; }
    .meals .chip { flex: 1 1 auto; padding: 0 12px; }
    .tabs { flex-wrap: wrap; border-radius: 22px; }
    .tabs button, .tabs.five button { flex: 1 1 auto; padding: 0 10px; font-size: 13px; }
  }
  .tabs.five button { font-size: 12.5px; padding: 0 2px; }
  .tabs button.on { background: var(--sel-bg); color: var(--sel-fg); }
  .panel { display: flex; flex-direction: column; gap: 12px; }
  .pane[hidden] { display: none; }
  .photo { align-self: stretch; }
  .empty { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 22px 20px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; color: var(--green-text); }
  .empty p { color: var(--quiet); font-size: 14px; line-height: 1.45; }
  .sub { font-size: 14px; font-weight: 700; color: var(--quiet); margin-top: 2px; }
  .combos li { background: var(--paper); border-radius: 20px; overflow: hidden; }
  .combos .row-pill { background: transparent; }
  .combos .row-pill .t strong { white-space: normal; overflow: visible; }
  .combos .row-pill .t small { white-space: normal; }
  .combos .v .u { font-size: 11px; font-weight: 500; color: var(--quiet); }
  .save { display: flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 16px; font-size: 13px; font-weight: 600; color: var(--green-text); }
  .save:disabled { opacity: 0.5; }
  .tpl li { background: var(--paper); border-radius: 20px; overflow: hidden; }
  .line { display: flex; align-items: center; gap: 4px; padding-right: 4px; }
  .line .row-pill { background: transparent; flex: 1; min-width: 0; }
  .line .round { background: var(--stone); }
  .tpl .v { display: flex; align-items: center; gap: 6px; }
  .tpl .v .u { font-size: 11px; font-weight: 500; margin-left: -3px; color: var(--quiet); }
  .tpl .v :global(svg) { color: var(--green-text); margin-left: 4px; }
  .menu { border-top: 1px solid var(--hairline); padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
  .menu .field input { background: var(--stone); }
  .menubtns { display: flex; gap: 8px; flex-wrap: wrap; }
  .menubtns .btn { flex: 1; min-width: 130px; }
</style>
