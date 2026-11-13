<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, inputNumber, parseNumber, t } from '../lib/i18n';
  import { recipePreview } from '../lib/nutrition';
  import { changed, toast, ui, type RecipeRequest } from '../lib/store.svelte';
  import type { Food, FoodImage, RecipeGroup, RecipeIn } from '../lib/types';
  import GroupAssign from './GroupAssign.svelte';
  import PhotoActions from './PhotoActions.svelte';
  import RecipeThumb from './RecipeThumb.svelte';
  import IngredientPicker from './IngredientPicker.svelte';
  import IngredientPaste from './IngredientPaste.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let { req }: { req: RecipeRequest } = $props();

  // the editor is re-created for every request ({#key} in App), so reading `req` once is intended
  // svelte-ignore state_referenced_locally
  const recipe = req.recipe;
  // svelte-ignore state_referenced_locally
  const draft = req.draft;

  interface Line { key: number; food: Food; amount: string }
  let nextKey = 1;
  // svelte-ignore state_referenced_locally
  let name = $state(recipe?.food.name ?? draft?.name ?? '');
  // svelte-ignore state_referenced_locally
  let portions = $state(inputNumber(recipe?.portions ?? draft?.portions ?? 2));
  let weight = $state(inputNumber(recipe?.total_weight));
  let lines = $state<Line[]>([]);
  let loading = $state(!!recipe);
  let lost = $state(0);
  let picking = $state(false);
  // the ingredient list that is pasted (or taken from a web page, `auto`): checked in its own sheet, then added as lines
  let pasting = $state<{ text: string; auto: boolean } | null>(null);
  let status = $state('');
  let saving = $state(false);
  let confirming = $state(false);
  let nameInput: HTMLInputElement;
  // the groups of an existing recipe are switched on and off at once (apart from the form's Save)
  let groups = $state<RecipeGroup[]>([]);
  const loadGroups = async () => { try { groups = await api.recipeGroups(); } catch { /* the chips stay as they were */ } };
  const groupsChanged = async () => { await loadGroups(); changed(); };

  // an existing recipe is recalculated from the CURRENT foods, so they are fetched; vanished ones drop out
  onMount(async () => {
    if (!recipe) return;
    void loadGroups();
    const loaded = await Promise.all(recipe.items.map(async (item) => {
      if (item.food_id == null) return null;
      try { return { food: await api.food(item.food_id), amount: item.amount }; } catch { return null; }
    }));
    lines = loaded.filter((l) => l !== null).map((l) => ({ key: nextKey++, food: l.food, amount: inputNumber(l.amount) }));
    lost = loaded.length - lines.length;
    loading = false;
  });

  // the photo: an existing recipe saves it at once (apart from the form's Save, like the groups); a new one keeps the chosen picture until it is saved
  // svelte-ignore state_referenced_locally
  let image = $state<FoodImage | null>(recipe?.food.image ?? null);
  let pending = $state<{ blob: Blob; url: string } | null>(null);
  let photoBusy = $state(false);
  const photoReason = (err: unknown) => (err instanceof ApiError && typeof err.detail === 'string' ? err.detail : err instanceof ApiError ? String(err.status || err.message) : 'error');
  async function pickPhoto(blob: Blob) {
    if (!recipe) {
      if (pending) URL.revokeObjectURL(pending.url);
      pending = { blob, url: URL.createObjectURL(blob) };
      return;
    }
    photoBusy = true;
    try { image = (await api.setFoodImage(recipe.food.id, blob)).image ?? null; changed(); toast(t('imgSaved')); }
    catch (err) { toast(t('imgFailed', { reason: photoReason(err) })); } finally { photoBusy = false; }
  }
  async function dropPhoto() {
    if (!recipe) { if (pending) URL.revokeObjectURL(pending.url); pending = null; return; }
    photoBusy = true;
    try { await api.removeFoodImage(recipe.food.id); image = null; changed(); toast(t('imgRemoved')); }
    catch (err) { toast(t('imgFailed', { reason: photoReason(err) })); } finally { photoBusy = false; }
  }
  $effect(() => () => { if (pending) URL.revokeObjectURL(pending.url); });

  const close = () => { ui.recipe = null; };
  const failMsg = (err: unknown) => t('recipeFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
  const amountOf = (line: Line) => {
    const v = parseNumber(line.amount);
    return v != null && !Number.isNaN(v) && v > 0 ? v : null;
  };

  const portionsN = $derived(parseNumber(portions));
  const weightN = $derived(parseNumber(weight));
  const preview = $derived(recipePreview(
    lines.flatMap((l) => { const amount = amountOf(l); return amount == null ? [] : [{ per_100: l.food.per_100, amount }]; }),
    portionsN != null && !Number.isNaN(portionsN) ? portionsN : 0,
    weightN != null && !Number.isNaN(weightN) && weightN > 0 ? weightN : null,
  ));
  const show = (v: number | null, digits = 0) => (v == null ? '–' : fmt(v, digits));

  function addFood(food: Food) {
    const key = nextKey++;
    lines.push({ key, food, amount: inputNumber(food.serving_quantity ?? 100) });
    picking = false;
    setTimeout(() => {
      const input = document.getElementById(`amt-${key}`) as HTMLInputElement | null;
      input?.scrollIntoView({ block: 'center' });
      input?.focus();
      input?.select();
    }, 80);
  }
  function addPasted(items: { food: Food; amount: number }[]) {
    for (const { food, amount } of items) lines.push({ key: nextKey++, food, amount: inputNumber(amount) });
    pasting = null;
    toast(t('pasteAdded', { n: items.length }));
  }
  const removeLine = (key: number) => { lines = lines.filter((l) => l.key !== key); };

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    status = '';
    const title = name.trim();
    if (!title) { status = t('nameRequired'); nameInput.focus(); return; }
    if (portionsN == null || Number.isNaN(portionsN) || portionsN <= 0) { status = t('recipeBadPortions'); document.getElementById('r-portions')?.focus(); return; }
    if (weightN !== null && (Number.isNaN(weightN) || weightN <= 0)) { status = t('recipeBadWeight'); document.getElementById('r-weight')?.focus(); return; }
    if (!lines.length) { status = t('recipeNeedIngredient'); return; }
    const bad = lines.find((l) => amountOf(l) == null);
    if (bad) { status = t('recipeBadAmount'); document.getElementById(`amt-${bad.key}`)?.focus(); return; }
    const body: RecipeIn = {
      name: title, portions: portionsN, total_weight: weightN,
      items: lines.map((l) => ({ food_id: l.food.id, amount: amountOf(l) as number })),
    };
    saving = true;
    try {
      if (recipe) await api.updateRecipe(recipe.id, body);
      else {
        const made = await api.createRecipe(body);
        if (pending) { try { await api.setFoodImage(made.food.id, pending.blob); } catch (err) { toast(t('imgFailed', { reason: photoReason(err) })); } }
      }
      ui.recipe = null;
      changed();
      toast(t('recipeSaved'));
    } catch (err) {
      status = failMsg(err);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!recipe) return;
    if (!confirming) { confirming = true; return; }
    saving = true;
    try {
      await api.deleteRecipe(recipe.id);
      ui.recipe = null;
      changed();
      toast(t('recipeDeleted'));
    } catch (err) {
      status = failMsg(err);
      confirming = false;
    } finally {
      saving = false;
    }
  }
</script>

<Sheet title={recipe ? t('recipeEdit') : t('recipeNew')} onclose={close} tall>
  <form onsubmit={submit}>
    <label class="field"><span>{t('rName')}</span><input bind:this={nameInput} bind:value={name} required maxlength="200" autocomplete="off" /></label>

    <section class="photo" aria-labelledby="r-photo">
      <h3 id="r-photo" class="micro quiet">{t('imgSection')}</h3>
      <div class="prow">
        {#if pending}
          <span class="prev"><img src={pending.url} alt="" /></span>
        {:else}
          <RecipeThumb food={{ image, name }} />
        {/if}
        <div class="pbtns">
          <PhotoActions tone="plain" take has={!!image || !!pending} busy={photoBusy} onpick={pickPhoto} />
          {#if image || pending}<button type="button" class="b plain" disabled={photoBusy} onclick={dropPhoto}>{t('imgRemove')}</button>{/if}
        </div>
      </div>
      <p class="note">{pending ? t('imgPending') : t('imgHint')}</p>
    </section>

    <div class="pair">
      <label class="field short"><span>{t('rPortions')}</span>
        <input id="r-portions" inputmode="decimal" autocomplete="off" bind:value={portions} aria-invalid={portionsN != null && (Number.isNaN(portionsN) || portionsN <= 0) ? 'true' : undefined} />
      </label>
      <label class="field grow"><span>{t('rWeight')}</span>
        <input id="r-weight" inputmode="decimal" autocomplete="off" placeholder={t('rWeightPlaceholder')} bind:value={weight} aria-describedby="r-weight-hint" />
      </label>
    </div>
    <p class="note" id="r-weight-hint">{t('rWeightHint')}</p>

    {#if draft && draft.ingredients.length}
      <!-- the ingredient lines of the web page: a reminder for this sitting only, never saved (the person picks the foods themself) -->
      <details class="memo">
        <summary>{t('wrDraft', { host: draft.host })} <small>({draft.ingredients.length})</small></summary>
        <ul>{#each draft.ingredients as line}<li>{line}</li>{/each}</ul>
        <button type="button" class="btn lime" onclick={() => (pasting = { text: draft.ingredients.join('\n'), auto: true })}>{t('wrCalc')}</button>
      </details>
    {/if}

    <h3 class="micro quiet">{t('rIngredients')}{lines.length ? ` · ${lines.length}` : ''}</h3>
    {#if loading}
      <p class="note">{t('searching')}</p>
    {:else if lines.length === 0}
      <p class="note">{t('noIngredients')}</p>
    {:else}
      <ul class="ings">
        {#each lines as line (line.key)}
          {@const kcal = line.food.per_100.kcal != null && amountOf(line) != null ? (line.food.per_100.kcal * (amountOf(line) as number)) / 100 : null}
          <li>
            <span class="t">
              <strong>{line.food.name || '?'}</strong>
              <small>{[line.food.brand, kcal == null ? null : `${fmt(Math.round(kcal))} kcal`].filter(Boolean).join(' · ')}</small>
            </span>
            <span class="amt">
              <input id="amt-{line.key}" class="input" inputmode="decimal" autocomplete="off" bind:value={line.amount}
                aria-label={t('ingredientAmount', { name: line.food.name || '?', unit: line.food.unit })}
                aria-invalid={line.amount !== '' && amountOf(line) == null ? 'true' : undefined} onfocus={(e) => e.currentTarget.select()} />
              <span class="mono unit">{line.food.unit}</span>
            </span>
            <button type="button" class="round" onclick={() => removeLine(line.key)} aria-label={t('removeIngredient', { name: line.food.name || '?' })}>
              <Icon name="close" size={18} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if lost}<p class="note warn">{t('recipeLost', { n: lost })}</p>{/if}
    <button type="button" class="btn lime" onclick={() => (picking = true)}><Icon name="plus" size={18} stroke={2.4} />{t('addIngredient')}</button>
    <button type="button" class="btn" onclick={() => (pasting = { text: '', auto: false })} disabled={loading}>{t('pasteOpen')}</button>

    <div class="result" aria-live="polite">
      {#if lines.length === 0}
        <p class="empty">{t('recipeEmptyResult')}</p>
      {:else}
        <span class="micro lab">{t('perPortion')}</span>
        <span class="big display">{show(preview.perPortion.kcal)}<span class="mono unit"> kcal</span></span>
        <span class="macros mono">
          <span>{t('protein')} {show(preview.perPortion.protein, 1)}</span> ·
          <span>{t('carbs')} {show(preview.perPortion.carbs, 1)}</span> ·
          <span>{t('fat')} {show(preview.perPortion.fat, 1)} g</span>
        </span>
        <span class="per100 mono">
          {t('perHundred')}: {show(preview.per100.kcal)} kcal · {show(preview.per100.protein, 1)} / {show(preview.per100.carbs, 1)} / {show(preview.per100.fat, 1)} g
        </span>
        <span class="per100 mono">{t('recipeWholeDish', { w: fmt(Math.round(preview.reference)) })}{preview.serving ? ` · ${t('recipeServing', { g: fmt(Math.round(preview.serving)) })}` : ''}</span>
      {/if}
    </div>

    {#if recipe}<GroupAssign foodId={recipe.food.id} {groups} onchange={groupsChanged} />{/if}

    <p class="note warn" role="status">{status}</p>
    <button class="btn primary" disabled={saving || loading}>{t('save')}</button>
    <button type="button" class="btn" onclick={close}>{t('cancel')}</button>
    {#if recipe}
      <button type="button" class="btn danger" onclick={remove} disabled={saving}>{confirming ? t('confirmDeleteRecipe') : t('deleteRecipe')}</button>
    {/if}
    <p class="note">{t('recipeHint')}</p>
  </form>
</Sheet>

{#if picking}<IngredientPicker onpick={addFood} onclose={() => (picking = false)} />{/if}
{#if pasting}<IngredientPaste initial={pasting.text} auto={pasting.auto} onapply={addPasted} onclose={() => (pasting = null)} />{/if}

<style>
  form { display: flex; flex-direction: column; gap: 12px; }
  .photo { display: flex; flex-direction: column; gap: 8px; }
  .prow { display: flex; align-items: center; gap: 12px; --thumb-bg: var(--paper); }
  .prow :global(.thumb), .prev { width: 72px; height: 72px; }
  .prev { flex: none; border-radius: 22px 22px 22px 8px; overflow: hidden; background: var(--paper); display: block; }
  .prev img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .pbtns { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
  .b { min-height: 46px; padding: 0 18px; border-radius: 24px 24px 24px 8px; font-weight: 700; font-size: 15px; display: inline-flex; align-items: center; gap: 8px; }
  .b.plain { background: var(--stone); color: var(--text); box-shadow: inset 0 0 0 2px var(--hairline); }
  .b:disabled { opacity: 0.6; }
  .pair { display: flex; gap: 10px; align-items: flex-end; }
  .short { width: 104px; flex-shrink: 0; }
  .grow { flex: 1; min-width: 0; }
  .grow > span { min-height: 2.7em; display: flex; align-items: flex-end; }
  .short > span { min-height: 2.7em; display: flex; align-items: flex-end; }
  h3 { margin-top: 4px; }
  .memo { background: var(--paper); border-radius: 20px; padding: 4px 8px; }
  .memo summary { min-height: 44px; display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; cursor: pointer; padding: 0 8px; }
  .memo summary small { color: var(--quiet); font-weight: 500; }
  .memo ul { padding: 0 8px 10px; display: flex; flex-direction: column; gap: 4px; max-height: 28vh; overflow-y: auto; }
  .memo .btn { margin: 0 8px 10px; }
  .memo li { font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
  .ings { display: flex; flex-direction: column; gap: 6px; }
  .ings li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; background: var(--paper); border-radius: 20px; padding: 6px 6px 6px 16px; min-height: 60px; }
  .t { display: flex; flex-direction: column; min-width: 0; }
  .t strong { font-size: 15px; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t small { font-size: 12px; color: var(--quiet); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .amt { display: flex; align-items: center; gap: 6px; }
  .amt .input { width: 84px; min-height: 44px; padding: 0 10px; text-align: right; background: var(--stone); font-family: var(--f-mono); font-weight: 600; font-size: 16px; }
  .amt .input[aria-invalid='true'] { border-color: var(--warn); }
  .unit { font-size: 12px; font-weight: 500; letter-spacing: 0; }
  .amt .unit { width: 18px; color: var(--quiet); }
  .ings .round { background: var(--stone); }
  .result { background: var(--deep); color: var(--on-deep); border-radius: 28px 28px 28px 8px; padding: 16px 20px; display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .result .empty { font-size: 14px; color: #cfd6cc; }
  .lab { color: var(--lime); }
  .big { font-size: 44px; line-height: 1; }
  .big .unit { margin-left: 6px; font-size: 14px; color: inherit; width: auto; }
  .macros { font-size: 12px; color: #cfd6cc; }
  .macros span { white-space: nowrap; }
  .per100 { font-size: 12px; color: #cfd6cc; margin-top: 6px; }
  .per100 + .per100 { margin-top: 0; }
</style>
