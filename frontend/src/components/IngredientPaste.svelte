<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, t } from '../lib/i18n';
  import { changePick, makeRow, readAmount, readiness, summarize, type Row } from '../lib/ingredients';
  import type { Food, IngredientCandidate } from '../lib/types';
  import IngredientPicker from './IngredientPicker.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  // "Paste ingredient list": the text, then a check step with one row per ingredient (food, amount, leave out), then the lines go to the recipe editor.
  let { initial = '', auto = false, onapply, onclose }:
    { initial?: string; auto?: boolean; onapply: (items: { food: Food; amount: number }[]) => void; onclose: () => void } = $props();

  const MAX_LINES = 200;
  const MAX_LINE = 300;
  // svelte-ignore state_referenced_locally
  let text = $state(initial);
  let step = $state<'text' | 'review'>('text');
  let busy = $state(false);
  let error = $state('');
  let rows = $state<Row[]>([]);
  let ignored = $state(0);
  let open = $state<number | null>(null);
  let changing = $state<number | null>(null);
  let applying = $state(false);

  const lineList = $derived(text.split(/\r?\n/));
  const tooLong = $derived(text.length > 20000 || lineList.length > MAX_LINES || lineList.some((l) => l.length > MAX_LINE));
  const summary = $derived(summarize(rows));
  const notAdded = $derived(summary.noFood + summary.noAmount);
  const reason = (err: unknown) => (err instanceof ApiError ? err.status || err.message : 'error');

  async function check() {
    if (busy || tooLong || !text.trim()) return;
    busy = true;
    error = '';
    try {
      const out = await api.matchIngredients(text);
      rows = out.lines.map(makeRow);
      ignored = out.ignored;
      open = null;
      if (!rows.length) error = t('pasteNone');
      else step = 'review';
    } catch (err) {
      error = t('pasteFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }
  onMount(() => { if (auto && text.trim()) void check(); });

  const fromFood = (f: Food): IngredientCandidate => ({
    source: f.source === 'own' || f.source === 'bls' || f.source === 'openfoodfacts' || f.source === 'yazio' ? f.source : 'own',
    food_id: f.id, code: f.code, name: f.name ?? '?', brand: f.brand, unit: f.unit, per_100: f.per_100,
  });
  const choose = (i: number, pick: IngredientCandidate) => { rows[i] = changePick(rows[i], pick); open = null; };
  const picked = (food: Food) => { if (changing != null) choose(changing, fromFood(food)); changing = null; };
  const typed = (i: number, value: string) => { rows[i] = { ...rows[i], amount: value, estimated: false }; };
  const skip = (i: number) => { rows[i] = { ...rows[i], skipped: !rows[i].skipped }; if (open === i) open = null; };
  const unitOf = (row: Row) => row.pick?.unit ?? 'g';
  const info = (c: IngredientCandidate) => [c.brand, c.source === 'bls' ? 'BLS' : null, c.per_100.kcal == null ? null : `${fmt(c.per_100.kcal)} kcal`].filter(Boolean).join(' · ');

  async function apply() {
    if (applying || !summary.ready) return;
    applying = true;
    error = '';
    const cache = new Map<string, Promise<Food>>();
    const resolve = (c: IngredientCandidate) => {
      const key = c.food_id != null ? `f${c.food_id}` : `${c.source}:${c.code}`;
      if (!cache.has(key)) cache.set(key, c.food_id != null ? api.food(c.food_id) : api.adoptCatalogItem({ source: c.source as 'bls' | 'openfoodfacts', code: c.code as string }));
      return cache.get(key) as Promise<Food>;
    };
    const ready = rows.filter((r) => readiness(r) === 'ready');
    const settled = await Promise.allSettled(ready.map((r) => resolve(r.pick as IngredientCandidate)));
    const failed = settled.filter((s) => s.status === 'rejected');
    if (failed.length) {
      error = t('pasteAdoptFailed', { n: failed.length, reason: reason((failed[0] as PromiseRejectedResult).reason) });
      applying = false;
      return;
    }
    onapply(ready.map((r, i) => ({ food: (settled[i] as PromiseFulfilledResult<Food>).value, amount: readAmount(r.amount) as number })));
  }
</script>

<Sheet title={t('pasteTitle')} {onclose} tall>
  {#if step === 'text'}
    <p class="note">{t('pasteIntro')}</p>
    <label class="field"><span class="sr">{t('pasteTitle')}</span>
      <textarea class="paste" rows="9" bind:value={text} placeholder={t('pastePlaceholder')} spellcheck="false" autocomplete="off" disabled={busy}></textarea>
    </label>
    <p class="note" class:warn={tooLong}>{t('pasteLimit')}</p>
    <p class="note warn" role="status">{error}</p>
    <button class="btn primary" onclick={check} disabled={busy || tooLong || !text.trim()}>{busy ? t('pasteChecking') : t('pasteCheck')}</button>
  {:else}
    <ul class="rows">
      {#each rows as row, i (row.line.line)}
        {@const state = readiness(row)}
        <li class:skipped={row.skipped} class:warn={state === 'no_food' || state === 'no_amount'}>
          <div class="orig">
            <span class="mono text">{row.line.text}</span>
            {#if row.line.optional}<span class="tag">{t('pasteOptional')}</span>{/if}
            {#if row.skipped}<span class="tag">{t('pasteLeftOut')}</span>
            {:else if state === 'no_amount'}<span class="tag bad">{t('pasteNeedAmount')}</span>
            {:else if row.estimated}<span class="tag est" title={t('pasteEstimatedHint')}>≈ {t('pasteEstimated')}</span>{/if}
          </div>
          <div class="main">
            <button type="button" class="food" aria-expanded={open === i} disabled={row.skipped} onclick={() => (open = open === i ? null : i)}>
              {#if row.pick}
                <strong>{row.pick.name}<Icon name="down" size={13} /></strong>
                <small>{info(row.pick)}</small>
              {:else}
                <strong class="none">{t('pasteNoFood')}</strong>
              {/if}
            </button>
            <span class="amt">
              <input class="input" inputmode="decimal" autocomplete="off" value={row.amount} disabled={row.skipped} placeholder="?"
                oninput={(e) => typed(i, e.currentTarget.value)} onfocus={(e) => e.currentTarget.select()}
                aria-label={t('pasteAmountAria', { text: row.line.text, unit: unitOf(row) })}
                aria-invalid={!row.skipped && row.pick && readAmount(row.amount) == null ? 'true' : undefined} />
              <span class="mono unit">{unitOf(row)}</span>
            </span>
            <button type="button" class="round" onclick={() => skip(i)} aria-label={row.skipped ? t('pasteRestore', { text: row.line.text }) : t('pasteSkip', { text: row.line.text })}>
              <Icon name={row.skipped ? 'plus' : 'close'} size={18} />
            </button>
          </div>
          {#if open === i}
            <div class="alts">
              {#if row.line.candidates.length > 1}
                <span class="micro quiet">{t('pasteOthers')}</span>
                <div class="chips">
                  {#each row.line.candidates as c}
                    <button type="button" class="chip" class:on={row.pick?.food_id === c.food_id && row.pick?.code === c.code} onclick={() => choose(i, c)}>{c.name}</button>
                  {/each}
                </div>
              {/if}
              <button type="button" class="btn small" onclick={() => (changing = i)} aria-label={t('pasteChange', { text: row.line.text })}>{t('pasteSearch')}</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    {#if ignored}<p class="note">{t('pasteIgnored', { n: ignored })}</p>{/if}
    <div class="sum" aria-live="polite">
      <strong>{t('pasteReady', { ready: summary.ready, total: rows.length - summary.skipped })}</strong>
      {#if summary.kcal != null}<span class="mono">{t('pasteKcal', { kcal: fmt(Math.round(summary.kcal)) })}</span>{/if}
      {#if notAdded}<span class="warn">{t('pasteNotAdded', { n: notAdded })}</span>{/if}
    </div>
    <p class="note warn" role="status">{error}</p>
    <button class="btn primary" onclick={apply} disabled={applying || !summary.ready}>{applying ? t('pasteApplying') : t('pasteApply', { n: summary.ready })}</button>
    <button class="btn" onclick={() => (step = 'text')} disabled={applying}>{t('pasteEdit')}</button>
  {/if}
</Sheet>

{#if changing != null}<IngredientPicker onpick={picked} onclose={() => (changing = null)} />{/if}

<style>
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .paste { width: 100%; min-height: 180px; padding: 14px 16px; border-radius: 22px; background: var(--paper); border: 2px solid var(--hairline); color: var(--text); font-family: var(--f-mono); font-size: max(16px, 1em); line-height: 1.5; resize: vertical; }
  .paste:focus-visible { outline-offset: 0; border-color: var(--focus-base); }
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
  .btn.small { min-height: 44px; padding: 0 16px; font-size: 14px; }
  .sum { background: var(--deep); color: var(--on-deep); border-radius: 24px 24px 24px 8px; padding: 14px 18px; display: flex; flex-direction: column; gap: 4px; }
  .sum span { font-size: 12.5px; }
  .sum .warn { color: #ffb3a3; }
</style>
