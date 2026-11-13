<script lang="ts">
  import { fmt, t } from '../lib/i18n';
  import { changePick, readAmount, readiness, rowPer100, rowUnit, summarize, takeEstimate, type Row } from '../lib/ingredients';
  import type { Food, IngredientCandidate } from '../lib/types';
  import IngredientPicker from './IngredientPicker.svelte';
  import Icon from './Icon.svelte';
  import type { Snippet } from 'svelte';

  // The check step of an ingredient list (pasted text, a recipe photo, a meal photo): one row per line with the food it was matched to, the amount
  // (both changeable) and "leave out"; below, the sum. A row that came from a meal photo may also carry the model's own values (`row.estimate`):
  // where no food of the database fits, the person can take those instead. What happens with the ready rows is the owner's business.
  let { rows = $bindable(), ignored = 0, macros = false, parts = false, extra }:
    { rows: Row[]; ignored?: number; /** also show the protein of the sum */ macros?: boolean; /** the rows are parts of a meal, not ingredients (wording) */ parts?: boolean; /** more lines inside the sum block */ extra?: Snippet<[ReturnType<typeof summarize>]> } = $props();

  let open = $state<number | null>(null);
  let changing = $state<number | null>(null);

  const summary = $derived(summarize(rows));
  const notAdded = $derived(summary.noFood + summary.noAmount);

  const fromFood = (f: Food): IngredientCandidate => ({
    source: f.source === 'own' || f.source === 'bls' || f.source === 'openfoodfacts' || f.source === 'yazio' ? f.source : 'own',
    food_id: f.id, code: f.code, name: f.name ?? '?', brand: f.brand, unit: f.unit, per_100: f.per_100,
  });
  const choose = (i: number, pick: IngredientCandidate) => { rows[i] = changePick(rows[i], pick); open = null; };
  const picked = (food: Food) => { if (changing != null) choose(changing, fromFood(food)); changing = null; };
  const typed = (i: number, value: string) => { rows[i] = { ...rows[i], amount: value, estimated: false }; };
  const skip = (i: number) => { rows[i] = { ...rows[i], skipped: !rows[i].skipped }; if (open === i) open = null; };
  const estimate = (i: number) => { rows[i] = takeEstimate(rows[i]); open = null; };
  const info = (c: Pick<IngredientCandidate, 'brand' | 'source'>, kcal: number | null | undefined) =>
    [c.brand, c.source === 'bls' ? 'BLS' : null, kcal == null ? null : `${fmt(kcal)} kcal`].filter(Boolean).join(' · ');
</script>

<ul class="rows">
  {#each rows as row, i (row.line.line)}
    {@const state = readiness(row)}
    {@const taken = row.useEstimate && row.estimate}
    <li class:skipped={row.skipped} class:warn={state === 'no_food' || state === 'no_amount'}>
      <div class="orig">
        <span class="mono text">{row.line.text}</span>
        {#if row.line.optional}<span class="tag">{t('pasteOptional')}</span>{/if}
        {#if row.skipped}<span class="tag">{t('pasteLeftOut')}</span>
        {:else if state === 'no_amount'}<span class="tag bad">{t('pasteNeedAmount')}</span>
        {:else if taken}<span class="tag est" title={t('visEstimateHint')}>≈ {t('visEstimateTag')}</span>
        {:else if row.estimated}<span class="tag est" title={t('pasteEstimatedHint')}>≈ {t('pasteEstimated')}</span>{/if}
      </div>
      <div class="main">
        <button type="button" class="food" aria-expanded={open === i} disabled={row.skipped} onclick={() => (open = open === i ? null : i)}>
          {#if taken && row.estimate}
            <strong>{t('visEstimateFood')}<Icon name="down" size={13} /></strong>
            <small>{t('visPer100', { kcal: fmt(rowPer100(row)?.kcal ?? 0) })}</small>
          {:else if row.pick}
            <strong>{row.pick.name}<Icon name="down" size={13} /></strong>
            <small>{info(row.pick, row.pick.per_100.kcal)}</small>
          {:else}
            <strong class="none">{t('pasteNoFood')}</strong>
          {/if}
        </button>
        <span class="amt">
          <input class="input" inputmode="decimal" autocomplete="off" value={row.amount} disabled={row.skipped} placeholder="?"
            oninput={(e) => typed(i, e.currentTarget.value)} onfocus={(e) => e.currentTarget.select()}
            aria-label={t('pasteAmountAria', { text: row.line.text, unit: rowUnit(row) })}
            aria-invalid={!row.skipped && (row.pick || taken) && readAmount(row.amount) == null ? 'true' : undefined} />
          <span class="mono unit">{rowUnit(row)}</span>
        </span>
        <button type="button" class="round" onclick={() => skip(i)} aria-label={row.skipped ? t('pasteRestore', { text: row.line.text }) : t('pasteSkip', { text: row.line.text })}>
          <Icon name={row.skipped ? 'plus' : 'close'} size={18} />
        </button>
      </div>
      {#if state === 'no_food' && open !== i}
        <div class="nofood">
          <button type="button" class="btn small" onclick={() => (changing = i)} aria-label={t('pasteChange', { text: row.line.text })}>{t('pasteSearch')}</button>
          {#if row.estimate}<button type="button" class="btn small" onclick={() => estimate(i)} aria-label={t('visUseEstimateAria', { text: row.line.text })}>{t('visUseEstimate')}</button>{/if}
        </div>
      {/if}
      {#if open === i}
        <div class="alts">
          {#if row.line.candidates.length > 1}
            <span class="micro quiet">{t('pasteOthers')}</span>
            <div class="chips">
              {#each row.line.candidates as c}
                <button type="button" class="chip" class:on={!taken && row.pick?.food_id === c.food_id && row.pick?.code === c.code} onclick={() => choose(i, c)}>{c.name}</button>
              {/each}
            </div>
          {/if}
          <div class="nofood">
            <button type="button" class="btn small" onclick={() => (changing = i)} aria-label={t('pasteChange', { text: row.line.text })}>{t('pasteSearch')}</button>
            {#if row.estimate && !taken}<button type="button" class="btn small" onclick={() => estimate(i)} aria-label={t('visUseEstimateAria', { text: row.line.text })}>{t('visUseEstimate')}</button>{/if}
          </div>
        </div>
      {/if}
    </li>
  {/each}
</ul>
{#if ignored}<p class="note">{t('pasteIgnored', { n: ignored })}</p>{/if}
<div class="sum" aria-live="polite">
  <strong>{t(parts ? 'visReady' : 'pasteReady', { ready: summary.ready, total: rows.length - summary.skipped })}</strong>
  {#if summary.kcal != null}<span class="mono">{t('pasteKcal', { kcal: fmt(Math.round(summary.kcal)) })}{#if macros && summary.protein != null}{' · '}{t('visProtein', { g: fmt(Math.round(summary.protein)) })}{/if}</span>{/if}
  {#if extra}{@render extra(summary)}{/if}
  {#if notAdded}<span class="warn">{t('pasteNotAdded', { n: notAdded })}</span>{/if}
</div>

{#if changing != null}<IngredientPicker onpick={picked} onclose={() => (changing = null)} />{/if}

<style>
  .rows { display: flex; flex-direction: column; gap: 8px; }
  .rows li { background: var(--paper); border-radius: 20px; padding: 10px 6px 6px 14px; display: flex; flex-direction: column; gap: 6px; }
  .rows li.warn { box-shadow: inset 0 0 0 2px var(--warn); }
  .rows li.warn .input, .rows li.warn .food strong:not(.none) { color: var(--text); }
  .rows li.skipped { opacity: 0.55; }
  .orig { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding-right: 8px; min-width: 0; }
  .text { font-size: 12.5px; color: var(--quiet); overflow-wrap: anywhere; min-width: 0; }
  .skipped .text { text-decoration: line-through; }
  .tag { font-family: var(--f-mono); font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 8px; border-radius: 10px; background: var(--hairline); color: var(--text); white-space: nowrap; }
  .tag.est { background: var(--lime); color: var(--on-lime); }
  .tag.bad { background: var(--warn); color: #fff; }
  .main { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 6px; }
  .food { display: flex; flex-direction: column; align-items: flex-start; text-align: left; min-height: 48px; padding: 2px 10px 2px 0; min-width: 0; gap: 0; }
  .food strong :global(svg) { margin-left: 4px; vertical-align: -1px; color: var(--quiet); }
  .food strong { font-size: 15px; font-weight: 600; line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .food strong.none { color: var(--warn); white-space: normal; }
  .food small { font-size: 12px; color: var(--quiet); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .amt { display: flex; align-items: center; gap: 4px; }
  .amt .input { width: 72px; min-height: 44px; padding: 0 8px; text-align: right; background: var(--stone); font-family: var(--f-mono); font-weight: 600; font-size: 16px; }
  .amt .input[aria-invalid='true'] { border-color: var(--warn); }
  .unit { font-size: 12px; width: 18px; color: var(--quiet); letter-spacing: 0; text-transform: none; }
  .rows .round { background: var(--stone); }
  .alts { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 4px 8px 8px 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { min-height: 40px; padding: 0 14px; border-radius: 20px; background: var(--stone); box-shadow: inset 0 0 0 2px var(--hairline); font-size: 14px; font-weight: 600; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip.on { background: var(--sel-bg); color: var(--sel-fg); box-shadow: none; }
  .nofood { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 8px 6px 0; }
  .btn.small { min-height: 44px; padding: 0 16px; font-size: 14px; }
  .sum { background: var(--deep); color: var(--on-deep); border-radius: 24px 24px 24px 8px; padding: 14px 18px; display: flex; flex-direction: column; gap: 4px; }
  .sum :global(span) { font-size: 12.5px; }
  .sum .warn { color: #ffb3a3; }
</style>
