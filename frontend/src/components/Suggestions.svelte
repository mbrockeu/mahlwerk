<script lang="ts">
  // "What still fits today": recipes (own, Cookidoo, web) that suit what is left of the day, worked out on the server from the goal, the
  // diary and when each recipe was last eaten (GET /recipes/suggestions). Two looks: `page` (the recipes page: a section above the list
  // with a choice of focus) and `card` (the day view: a quiet card under the meals that folds up). "+" opens the normal amount dialog with
  // the recommended amount in it. The tone is plain: the numbers, never a lecture; with the goal reached it says so and waits to be asked.
  import { untrack } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, t } from '../lib/i18n';
  import { portionsLabel, sourceLabel } from '../lib/portion';
  import { mealByTime, openAmount, ui } from '../lib/store.svelte';
  import type { Food, SuggestFocus, SuggestionItem, Suggestions } from '../lib/types';
  import Icon from './Icon.svelte';
  import RecipeThumb from './RecipeThumb.svelte';

  let { day, variant, group, onpick }: { day: string; variant: 'page' | 'card'; group?: string; onpick?: (food: Food) => void } = $props();

  const FOCI: SuggestFocus[] = ['balanced', 'protein', 'light', 'rotation'];
  // svelte-ignore state_referenced_locally
  const KEY = `mahlwerk.suggest-open-${variant}`;
  const remembered = () => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } };
  let open = $state(remembered());
  let focus = $state<SuggestFocus>('balanced');
  let anyway = $state(false);
  let data = $state<Suggestions | null>(null);
  let error = $state('');
  let token = 0;

  async function load() {
    const mine = ++token;
    try {
      const result = await api.suggestions(day, { focus, group, limit: variant === 'page' ? 4 : 3, anyway });
      if (mine !== token) return;
      data = result;
      error = '';
    } catch (err) {
      if (mine === token) error = t('sgFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    }
  }
  // reload when the day, the focus, the group or the diary changes (booking something moves the rest of the day)
  $effect(() => { day; focus; group; anyway; ui.version; untrack(() => { void load(); }); });
  $effect(() => { group; focus; day; untrack(() => { anyway = false; }); });

  const toggle = () => { open = !open; try { localStorage.setItem(KEY, open ? '1' : '0'); } catch { /* the choice is only a convenience */ } };
  const rest = $derived(data?.rest.kcal ?? null);
  const proteinOpen = $derived(data?.rest.protein != null && data.rest.protein > 0 ? Math.round(data.rest.protein) : null);
  const restLine = $derived(
    !data || rest == null ? '' : rest >= 0 ? [t('sgRest', { kcal: fmt(Math.round(rest)) }), proteinOpen == null ? '' : t('sgRestProtein', { n: fmt(proteinOpen) })].filter(Boolean).join(' · ')
      : t('sgOver', { n: fmt(Math.round(-rest)) }),
  );
  const visible = $derived(variant === 'page' || (data != null && data.candidates > 0));
  const reasonText = (item: SuggestionItem) => item.reasons.map((r) => t(`sgR_${r}`)).join(' · ');
  const then = (item: SuggestionItem) => (item.after.kcal == null ? '' : item.after.kcal >= 0 ? t('sgThen', { kcal: fmt(Math.round(item.after.kcal)) }) : t('sgThenOver', { kcal: fmt(Math.round(-item.after.kcal)) }));
  const add = (item: SuggestionItem) => openAmount({ food: item.food, meal: mealByTime(), day, amount: item.amount });
  const title = $derived(variant === 'page' ? t('sgTitle') : t('sgCardTitle'));
  // a tiny picture before the name, only while at least one of the shown recipes has one (then the others get the quiet stand-in, so the names line up)
  const pictured = $derived((data?.items ?? []).some((i) => !!i.food.image?.hash));
</script>

{#if visible}
  <section class="sg v-{variant}" aria-labelledby="sg-{variant}-t" data-testid="suggestions-{variant}">
    <header>
      <button type="button" class="head" aria-expanded={open} aria-controls="sg-{variant}-body" onclick={toggle}
        title={open ? t('sgCollapse') : t('sgExpand')}>
        <span class="tt">
          <h2 id="sg-{variant}-t" class="micro">{title}</h2>
          {#if restLine && (!open || variant === 'card')}<span class="rest">{restLine}</span>{/if}
        </span>
        <span class="chev" class:up={open}><Icon name="down" size={20} /></span>
      </button>
    </header>

    {#if open}
      <div id="sg-{variant}-body" class="body" aria-live="polite">
        {#if variant === 'page'}
          {#if restLine}<p class="rest">{restLine}</p>{/if}
          <div class="foci" role="group" aria-label={t('sgFocusAria')}>
            {#each FOCI as f (f)}
              <button type="button" class="chip" class:on={focus === f} aria-pressed={focus === f} onclick={() => (focus = f)}>{t(`sgF_${f}`)}</button>
            {/each}
          </div>
        {/if}

        {#if error}
          <p class="note warn" role="alert">{error}</p>
        {:else if !data}
          <p class="note">{t('sgLoading')}</p>
        {:else}
          {#if data.state === 'no_goal' && data.items.length}<p class="note">{t('sgNoGoal')}</p>{/if}
          {#if data.state === 'no_recipes'}
            <p class="note">{t('sgNone')}</p>
          {:else if data.state === 'goal_reached'}
            <p class="note calm">{t('sgGoalReached')}</p>
            {#if !anyway}<button type="button" class="btn small" onclick={() => (anyway = true)}>{t('sgAnyway')}</button>{/if}
          {:else if data.state === 'nothing_fits'}
            <p class="note">{t('sgNothingFits')}</p>
          {/if}
          {#if data.items.length}
            <ul class="cards">
              {#each data.items as item (item.food.id)}
                {@const tag = sourceLabel(item.food)}
                <li class="sc">
                  {#if onpick}
                    <button type="button" class="main" onclick={() => onpick?.(item.food)}>
                      {@render body(item, tag)}
                    </button>
                  {:else}
                    <div class="main">{@render body(item, tag)}</div>
                  {/if}
                  <button type="button" class="round add" onclick={() => add(item)}
                    aria-label={t('sgAdd', { name: item.food.name ?? '?', amount: portionsLabel(item.portions) })} title={t('sgAdd', { name: item.food.name ?? '?', amount: portionsLabel(item.portions) })}>
                    <Icon name="plus" size={20} stroke={2.4} />
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>
    {/if}
  </section>
{/if}

{#snippet body(item: SuggestionItem, tag: string | null)}
  {#if pictured}<RecipeThumb food={item.food} size="s" />{/if}
  <span class="tx">
  <span class="top">
    <strong>{item.food.name ?? '?'}</strong>
    {#if tag}<span class="tag">{tag}</span>{/if}
  </span>
  <span class="nums mono">{portionsLabel(item.portions)} · {fmt(Math.round(item.kcal))} kcal{item.protein == null ? '' : ` · ${t('sgProtein', { n: fmt(item.protein, 0) })}`}</span>
  {#if item.reasons.length}<span class="why">{reasonText(item)}</span>{/if}
  <span class="then mono">{then(item)}</span>
  </span>
{/snippet}

<style>
  .sg { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 4px 8px 8px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .sg.v-card { background: transparent; box-shadow: inset 0 0 0 2px var(--hairline); }
  .head { width: 100%; min-height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 8px 4px 14px; text-align: left; border-radius: 20px; }
  .tt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  h2 { color: var(--quiet); }
  .chev { display: inline-flex; width: 44px; height: 44px; align-items: center; justify-content: center; flex-shrink: 0; transition: transform 160ms; }
  .chev.up { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
  .rest { font-size: 13px; font-weight: 600; color: var(--text); }
  .body { display: flex; flex-direction: column; gap: 10px; padding: 0 6px 6px; }
  .foci { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; padding: 2px; margin: 0 -2px; }
  .foci::-webkit-scrollbar { display: none; }
  .foci .chip { flex-shrink: 0; background: var(--stone); }
  .foci .chip.on { background: var(--sel-bg); }
  .calm { font-size: 14px; color: var(--text); }
  .btn.small { align-self: flex-start; min-height: 44px; padding: 0 16px; font-size: 14px; }
  .cards { display: flex; flex-direction: column; gap: 8px; }
  .sc { display: flex; align-items: stretch; gap: 6px; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: row; align-items: center; gap: 10px; text-align: left; padding: 10px 14px; border-radius: 22px 22px 22px 8px; background: var(--stone); min-height: 56px; --thumb-bg: var(--paper); }
  .tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .top { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .top strong { font-size: 15px; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .tag { font-family: var(--f-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; padding: 1px 6px; border-radius: 8px; background: var(--hairline); color: var(--text); flex-shrink: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nums { font-size: 12px; font-weight: 600; }
  .why { font-size: 13px; color: var(--text); line-height: 1.3; }
  .then { font-size: 11px; color: var(--quiet); }
  .add { align-self: center; background: var(--stone); border: 2px solid var(--hairline); }
</style>
