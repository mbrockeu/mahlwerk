<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { fmt, t } from '../lib/i18n';
  import { buildMealRows, estimateFood, matchLine, readAmount, readiness, summarize, type Row } from '../lib/ingredients';
  import { changed, closeAdd, toast } from '../lib/store.svelte';
  import type { Entry, Food, IngredientCandidate, Meal, VisionMeal } from '../lib/types';
  import IngredientReview from './IngredientReview.svelte';
  import PhotoCapture from './PhotoCapture.svelte';

  // "Photo of the meal" in the add sheet: photo -> the model names the parts and guesses the amounts -> Mahlwerk matches each part to a food of the
  // database (the same matcher as "Paste ingredient list") -> the person checks the rows -> they are booked into the chosen meal of the chosen day.
  // Where no food fits, the model's own values can be taken: that makes an own food (per 100 g from the estimate). Nothing is kept of the photo.
  let { meal, day, onback }: { meal: Meal; day: string; onback: () => void } = $props();

  let step = $state<'capture' | 'review'>('capture');
  let rows = $state<Row[]>([]);
  let note = $state<string | null>(null);
  let booking = $state(false);
  let error = $state('');

  const summary = $derived(summarize(rows));
  const reason = (err: unknown) => (err instanceof ApiError ? (typeof err.detail === 'string' && err.status === 422 ? err.detail : err.status || err.message) : 'error');

  async function received(result: VisionMeal | unknown) {
    const found = result as VisionMeal;
    const out = await api.matchIngredients(found.items.map(matchLine).join('\n'));
    rows = buildMealRows(found.items, out.lines);
    note = found.note;
    error = '';
    step = 'review';
  }

  async function book() {
    if (booking || !summary.ready) return;
    booking = true;
    error = '';
    const made: Entry[] = [];
    const created: Food[] = [];
    const foods = new Map<string, Promise<Food>>();
    const resolve = (row: Row, index: number): Promise<Food> => {
      if (row.useEstimate && row.estimate) {
        const key = `e${index}`;
        if (!foods.has(key)) foods.set(key, api.createFood(estimateFood(row.line.text, row.estimate)).then((f) => { created.push(f); return f; }));
        return foods.get(key) as Promise<Food>;
      }
      const c = row.pick as IngredientCandidate;
      const key = c.food_id != null ? `f${c.food_id}` : `${c.source}:${c.code}`;
      if (!foods.has(key)) foods.set(key, c.food_id != null ? api.food(c.food_id) : api.adoptCatalogItem({ source: c.source as 'bls' | 'openfoodfacts', code: c.code as string }));
      return foods.get(key) as Promise<Food>;
    };
    try {
      const ready = rows.map((r, i) => ({ r, i })).filter(({ r }) => readiness(r) === 'ready');
      for (const { r, i } of ready) {
        const food = await resolve(r, i);
        made.push(await api.addEntry(day, { food_id: food.id, meal, amount: readAmount(r.amount) as number }));
      }
    } catch (err) {
      // all or nothing: what was booked a moment ago is taken back, so a second try does not double it
      await Promise.allSettled(made.map((e) => api.deleteEntry(e.id)));
      await Promise.allSettled(created.map((f) => api.deleteFood(f.id)));
      error = t('visBookFailed', { reason: reason(err) });
      booking = false;
      return;
    }
    closeAdd();
    changed();
    toast(t('visBooked', { n: made.length }), {
      label: t('undo'),
      run: async () => {
        await Promise.allSettled(made.map((e) => api.deleteEntry(e.id)));
        await Promise.allSettled(created.map((f) => api.deleteFood(f.id)));
        changed();
        toast(t('undone'));
      },
    });
  }
</script>

<div class="mp">
  {#if step === 'capture'}
    <PhotoCapture kind="meal" onresult={received} />
    <button type="button" class="btn quiet-btn" onclick={onback}>{t('visBack')}</button>
  {:else}
    <p class="hint" role="note"><strong>{t('visEstimatesNote')}</strong></p>
    {#if note}<p class="note modelnote"><span class="micro quiet">{t('visModelNote')}</span> {note}</p>{/if}
    <IngredientReview bind:rows macros parts>
      {#snippet extra()}<span class="mono">{t('visWhere', { meal: t(meal) })}</span>{/snippet}
    </IngredientReview>
    <p class="note warn" role="status">{error}</p>
    <button class="btn primary" onclick={book} disabled={booking || !summary.ready}>{booking ? t('visBooking') : t('visBook', { n: summary.ready })}</button>
    <button class="btn" onclick={() => { step = 'capture'; error = ''; }} disabled={booking}>{t('visOther')}</button>
  {/if}
</div>

<style>
  .mp { display: flex; flex-direction: column; gap: 12px; }
  .hint { background: var(--lime); color: var(--on-lime); border-radius: 18px; padding: 10px 14px; font-size: 14px; line-height: 1.4; }
  .modelnote { overflow-wrap: anywhere; }
</style>
