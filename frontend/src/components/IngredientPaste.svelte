<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, t } from '../lib/i18n';
  import { readAmount, readiness, makeRow, summarize, type Row } from '../lib/ingredients';
  import { perPortion } from '../lib/vision';
  import type { Food, IngredientCandidate, VisionRecipe } from '../lib/types';
  import IngredientReview from './IngredientReview.svelte';
  import PhotoCapture from './PhotoCapture.svelte';
  import Sheet from './Sheet.svelte';
  import { photoNutrition, recipeLines } from '../lib/vision';

  // "Paste ingredient list": the text, then a check step with one row per ingredient (food, amount, leave out), then the lines go to the recipe editor.
  // From a photo of a recipe the text is the model's ingredient lines and the check step opens at once (`auto`); then the values printed on the photo
  // can be compared with the sum per portion (`compare`, `portions`), and `more` offers another photo for a recipe on several pages.
  let { initial = '', auto = false, onapply, onclose, compare = null, portions = null, more = false }: {
    initial?: string; auto?: boolean; onapply: (items: { food: Food; amount: number }[]) => void; onclose: () => void;
    compare?: { kcal: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null } | null;
    portions?: number | null; more?: boolean;
  } = $props();

  const MAX_LINES = 200;
  const MAX_LINE = 300;
  // svelte-ignore state_referenced_locally
  let text = $state(initial);
  let step = $state<'text' | 'review'>('text');
  let busy = $state(false);
  let error = $state('');
  let rows = $state<Row[]>([]);
  let ignored = $state(0);
  let applying = $state(false);
  let adding = $state(false);
  // svelte-ignore state_referenced_locally
  let printed = $state(compare);

  const lineList = $derived(text.split(/\r?\n/));
  const tooLong = $derived(text.length > 20000 || lineList.length > MAX_LINES || lineList.some((l) => l.length > MAX_LINE));
  const summary = $derived(summarize(rows));
  const reason = (err: unknown) => (err instanceof ApiError ? err.status || err.message : 'error');
  const portionKcal = $derived(perPortion(summary.kcal, portions));

  async function check() {
    if (busy || tooLong || !text.trim()) return;
    busy = true;
    error = '';
    try {
      const out = await api.matchIngredients(text);
      rows = out.lines.map(makeRow);
      ignored = out.ignored;
      if (!rows.length) error = t('pasteNone');
      else step = 'review';
    } catch (err) {
      error = t('pasteFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }
  onMount(() => { if (auto && text.trim()) void check(); });

  // another photo of the same recipe: its lines are checked on their own and appended (what was changed above stays as it is)
  async function addPhoto(result: VisionRecipe) {
    adding = false;
    const lines = recipeLines(result);
    if (!lines.length) { error = t('visNoIngredients'); return; }
    error = '';
    busy = true;
    try {
      const out = await api.matchIngredients(lines.join('\n'));
      const offset = rows.reduce((m, r) => Math.max(m, r.line.line), 0);
      rows = [...rows, ...out.lines.map((l) => makeRow({ ...l, line: l.line + offset }))];
      ignored += out.ignored;
      printed ??= photoNutrition(result);
    } catch (err) {
      error = t('pasteFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }

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
    <IngredientReview bind:rows {ignored}>
      {#snippet extra()}
        {#if portionKcal != null}<span class="mono">{t('visPortionKcal', { kcal: fmt(Math.round(portionKcal)) })}</span>{/if}
        {#if printed?.kcal != null}
          <span class="mono printed">{t('visOnPhoto', { kcal: fmt(Math.round(printed.kcal)) })}</span>
        {/if}
      {/snippet}
    </IngredientReview>
    <p class="note warn" role="status">{error}</p>
    <button class="btn primary" onclick={apply} disabled={applying || busy || !summary.ready}>{applying ? t('pasteApplying') : t('pasteApply', { n: summary.ready })}</button>
    {#if more}<button class="btn" onclick={() => (adding = true)} disabled={applying || busy}>{busy ? t('pasteChecking') : t('visAddPhoto')}</button>{/if}
    <button class="btn" onclick={() => (step = 'text')} disabled={applying}>{t('pasteEdit')}</button>
  {/if}
</Sheet>

{#if adding}
  <Sheet title={t('visAddPhoto')} onclose={() => (adding = false)}>
    <PhotoCapture kind="recipe" onresult={(r) => addPhoto(r as VisionRecipe)} />
  </Sheet>
{/if}

<style>
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .paste { width: 100%; min-height: 180px; padding: 14px 16px; border-radius: 22px; background: var(--paper); border: 2px solid var(--hairline); color: var(--text); font-family: var(--f-mono); font-size: max(16px, 1em); line-height: 1.5; resize: vertical; }
  .paste:focus-visible { outline-offset: 0; border-color: var(--focus-base); }
</style>
