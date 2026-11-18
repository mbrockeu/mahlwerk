<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, inputNumber, parseNumber, t } from '../lib/i18n';
  import { checkPiece, gramsToPieces, isHalfMultiple, MAX_LABEL, piecesToGrams, splitGrams } from '../lib/piece';
  import { isPortionEntry, isPortionFood, PORTION_GRAMS } from '../lib/portion';
  import { backToAdd, changed, toast, ui, type AmountRequest } from '../lib/store.svelte';
  import { MEALS, type FoodPiece, type Meal } from '../lib/types';
  import Sheet from './Sheet.svelte';

  let { req }: { req: AmountRequest } = $props();

  // the sheet is re-created for every request ({#key} in App), so reading `req` once is intended
  // svelte-ignore state_referenced_locally
  const food = req.food;
  // svelte-ignore state_referenced_locally
  const entry = req.entry;
  const unit = (food?.unit ?? entry?.unit ?? 'g') as 'g' | 'ml';
  const title = (food?.name ?? entry?.name) || '?';
  const brand = food?.brand ?? entry?.brand ?? null;
  // a Cookidoo recipe is stored as 100 g = 1 portion: here it is typed, shown and booked as portions
  const byPortion = isPortionFood(food) || isPortionEntry(entry);
  const scale = byPortion ? PORTION_GRAMS : 1;
  // a piece ("slice" = 25 g) of the food, if a person defined one: the field then counts pieces and the diary still gets grams
  const foodId = food?.id ?? entry?.food_id ?? null;
  // svelte-ignore state_referenced_locally
  let piece = $state<FoodPiece | null>(byPortion ? null : (food?.piece ?? null));
  let inPieces = $state(false);
  const factor = $derived(inPieces && piece ? piece.grams : scale);
  const toBooked = (v: number) => Math.round(v * factor * 1000) / 1000;

  // nutrients per 100 g/ml (for an existing entry derived from its scaled values)
  const per = (key: 'kcal' | 'protein' | 'carbs' | 'fat'): number | null => {
    if (food) return food.per_100[key];
    const v = entry?.[key];
    return v == null || !entry || entry.amount <= 0 ? null : (v / entry.amount) * 100;
  };
  const p100 = { kcal: per('kcal'), protein: per('protein'), carbs: per('carbs'), fat: per('fat') };

  // svelte-ignore state_referenced_locally
  let last = $state<number | null>(req.lastAmount == null ? null : req.lastAmount / scale);
  // the amount the dialog starts with, in g/ml as booked (nothing given and a piece known: one piece)
  // svelte-ignore state_referenced_locally
  const start = byPortion ? null : (entry?.amount ?? req.amount ?? (piece ? (req.lastAmount ?? null) : (food?.serving_quantity ?? 100)));
  // svelte-ignore state_referenced_locally
  let text = $state(byPortion ? inputNumber(entry ? entry.amount / scale : (req.amount ?? scale) / scale) : inputNumber(start ?? piece?.grams ?? 100));
  // typed or changed by the person: a piece that arrives late then no longer switches the field under their fingers
  let touched = false;
  // pieces are the default once defined, unless the start amount is not a whole or half number of pieces: then it stays in grams
  function usePiece(p: FoodPiece | null) {
    piece = p;
    if (!p || touched) return;
    if (start == null || isHalfMultiple(start, p.grams)) {
      inPieces = true;
      text = inputNumber(start == null ? 1 : gramsToPieces(start, p.grams));
    }
  }
  // svelte-ignore state_referenced_locally
  usePiece(piece);
  // svelte-ignore state_referenced_locally
  let meal = $state<Meal>(req.meal);
  let saving = $state(false);
  let error = $state('');
  let confirming = $state(false);
  // the piece is shared: a guest may set it only on what they made (the server refuses it too)
  // svelte-ignore state_referenced_locally
  let editable = $state(food ? food.can_edit !== false : !entry);
  // for a drink in ml: does it count towards the day's water? (food setting: null automatic, true yes, false no; shared like the piece)
  // svelte-ignore state_referenced_locally
  let drink = $state<boolean | null>(food?.drink ?? null);
  let drinkBusy = $state(false);
  const drinkChoices: { value: boolean | null; label: () => string }[] = [
    { value: null, label: () => t('drinkAuto') }, { value: true, label: () => t('drinkYes') }, { value: false, label: () => t('drinkNo') },
  ];
  async function setDrink(next: boolean | null) {
    if (foodId == null || drinkBusy || next === drink) return;
    drinkBusy = true;
    error = '';
    try {
      drink = (await api.setFoodDrink(foodId, next)).drink ?? null;
      if (food) food.drink = drink;
    } catch (err) {
      error = failMsg(err);
    } finally {
      drinkBusy = false;
    }
  }

  const amount = $derived(parseNumber(text));
  const valid = $derived(amount != null && !Number.isNaN(amount) && amount > 0 && toBooked(amount) <= 5000);
  const calc = (v: number | null) => (v == null || !valid ? null : (v * toBooked(amount as number)) / 100);
  const kcal = $derived(calc(p100.kcal));

  onMount(async () => {
    // an entry brings no piece: ask for the food it came from (the piece is optional, a failure changes nothing)
    if (!food && entry && foodId != null && !byPortion) {
      api.food(foodId).then((f) => { editable = f.can_edit !== false; drink = f.drink ?? null; if (f.piece && !piece) usePiece(f.piece); }).catch(() => {});
    }
    if (!food || last != null) return;
    try {
      const recent = await api.recent(50);
      const found = recent.find((r) => r.food.id === food.id)?.last_amount;
      last = found == null ? null : found / scale;
    } catch { /* the quick pick is optional */ }
  });

  const quick = $derived.by(() => {
    const list: { label: string; value: number }[] = [];
    if (inPieces && piece) {
      for (const n of [1, 2, 3]) list.push({ label: t('piecesN', { n: String(n), label: piece.label }), value: n });
      const count = last == null ? null : gramsToPieces(last, piece.grams);
      if (count != null && isHalfMultiple(last as number, piece.grams) && !list.some((q) => q.value === count)) list.push({ label: t('pieceLast', { n: fmt(count, 1), label: piece.label }), value: count });
      return list;
    }
    if (byPortion) {
      list.push({ label: t('halfPortion'), value: 0.5 }, { label: t('portions1'), value: 1 }, { label: t('portionsN', { n: '2' }), value: 2 });
      if (last != null && !list.some((q) => q.value === last)) list.push({ label: t('lastTime', { amount: t('portionsN', { n: fmt(last, 2) }) }), value: last });
      return list;
    }
    if (food?.serving_quantity) list.push({ label: t('portion', { s: `${fmt(food.serving_quantity, 1)} ${unit}` }), value: food.serving_quantity });
    list.push({ label: t('hundred', { unit }), value: 100 });
    if (last != null && !list.some((q) => q.value === last)) list.push({ label: t('lastAmount', { a: fmt(last, 1), unit }), value: last });
    return list;
  });

  // − and + beside the field: one serving (two slices of toast), half a portion of a recipe, else 10 g/ml
  const serving = byPortion ? null : (food?.serving_quantity ?? null);
  const step = $derived(inPieces ? 1 : byPortion ? 0.5 : (serving ?? 10));
  const round = (v: number) => Math.round(v * 1000) / 1000;
  function stepBy(dir: 1 | -1) {
    touched = true;
    const now = valid ? (amount as number) : 0;
    const n = dir > 0 ? Math.floor(now / step + 1e-9) + 1 : Math.ceil(now / step - 1e-9) - 1;  // the next whole step
    text = inputNumber(round(Math.max(1, n) * step));
  }
  const servings = $derived(serving && valid && !inPieces ? round((amount as number) / serving) : null);
  const stepText = $derived(inPieces && piece ? t('piecesN', { n: '1', label: piece.label }) : byPortion ? t('portionsN', { n: fmt(step, 1) }) : `${fmt(step, 1)} ${unit}`);
  // the other way round: grams with a piece defined say how many pieces that is, pieces say how many grams
  const pieceNote = $derived.by(() => {
    if (!piece || !valid) return null;
    const grams = toBooked(amount as number);
    if (inPieces) return `= ${fmt(grams, 1)} ${unit}`;
    return isHalfMultiple(grams, piece.grams) ? `= ${t('piecesN', { n: fmt(gramsToPieces(grams, piece.grams), 1), label: piece.label })}` : null;
  });

  // the unit switch converts what is typed; a half piece or an odd gram amount stays exact to three digits
  function setMode(pieces: boolean) {
    if (!piece || pieces === inPieces) return;
    touched = true;
    const grams = valid ? toBooked(amount as number) : null;
    inPieces = pieces;
    text = inputNumber(pieces ? (grams == null ? 1 : gramsToPieces(grams, piece.grams)) : (grams ?? piece.grams));
  }

  // the small form that says what one piece is (new, or change/remove an existing one)
  let formOpen = $state(false);
  let formLabel = $state('');
  let formGrams = $state('');
  let formBusy = $state(false);
  let formError = $state('');
  function openForm() {
    formLabel = piece?.label ?? t('pieceNameDefault');
    const now = piece ? piece.grams : valid && !byPortion ? toBooked(amount as number) : null;
    formGrams = now == null || now > 5000 ? '' : inputNumber(now);
    formError = '';
    formOpen = true;
  }
  async function savePiece() {
    const draft = checkPiece(formLabel, parseNumber(formGrams));
    if (!draft) { formError = t('pieceBad'); return; }
    if (foodId == null) return;
    formBusy = true;
    formError = '';
    try {
      const saved = (await api.setFoodPiece(foodId, draft)).piece ?? draft;
      const first = !piece;
      touched = true;
      piece = saved;
      if (food) food.piece = saved;
      if (first) { inPieces = true; text = '1'; }
      formOpen = false;
    } catch (err) {
      formError = failMsg(err);
    } finally {
      formBusy = false;
    }
  }
  async function removePiece() {
    if (foodId == null) return;
    formBusy = true;
    formError = '';
    try {
      await api.removeFoodPiece(foodId);
      // what was typed stays as the same amount, now in grams
      const grams = valid ? toBooked(amount as number) : null;
      touched = true;
      piece = null;
      if (food) food.piece = null;
      inPieces = false;
      text = inputNumber(grams ?? 100);
      formOpen = false;
    } catch (err) {
      formError = failMsg(err);
    } finally {
      formBusy = false;
    }
  }

  // a share of a whole: the cake weighs 1250 g, cut into 8, 2 eaten; the result goes into the field as grams
  let splitOpen = $state(false);
  let splitTotal = $state('');
  let splitParts = $state('8');
  let splitEaten = $state('1');
  const split = $derived(splitGrams(parseNumber(splitTotal), parseNumber(splitParts), parseNumber(splitEaten)));
  const splitOne = $derived.by(() => {
    const total = parseNumber(splitTotal), parts = parseNumber(splitParts);
    return split == null || total == null || parts == null ? null : round(total / parts);
  });
  // the whole starts as what the field holds (in g/ml): typed 1250 there, it is used without typing it again
  function openSplit() {
    splitTotal = valid ? inputNumber(toBooked(amount as number)) : '';
    splitOpen = true;
  }
  function takeSplit() {
    if (split == null) return;
    touched = true;
    inPieces = false;
    text = inputNumber(split);
    splitOpen = false;
  }

  // came from the add sheet: closing (swipe down, ✕, a tap beside) goes back there, like a step back on a phone
  const close = () => { if (req.back) backToAdd(); else ui.amount = null; };
  const failMsg = (err: unknown) => t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });

  async function save() {
    if (!valid) { error = t('badAmount'); return; }
    saving = true;
    error = '';
    try {
      if (entry) {
        await api.patchEntry(entry.id, { amount: toBooked(amount as number), meal });
        toast(t('changed'));
      } else if (food) {
        await api.addEntry(req.day, { food_id: food.id, meal, amount: toBooked(amount as number) });
        toast(t('added', { name: title }));
      }
      ui.amount = null;
      changed();
    } catch (err) {
      error = failMsg(err);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!entry) return;
    if (!confirming) { confirming = true; return; }
    saving = true;
    try {
      await api.deleteEntry(entry.id);
      toast(t('deleted'));
      ui.amount = null;
      changed();
    } catch (err) {
      error = failMsg(err);
      confirming = false;
    } finally {
      saving = false;
    }
  }
</script>

<Sheet title={entry ? t('amountEdit') : t('amount')} onclose={close} onback={req.back ? backToAdd : undefined} label={title}>
  <div class="who">
    <h3>{title}</h3>
    <p class="note">{[brand, p100.kcal != null ? t(byPortion ? 'perPortionShort' : 'per100Short', { kcal: fmt(p100.kcal, 0), unit }) : null].filter(Boolean).join(' · ')}</p>
  </div>

  <div class="meals" role="group" aria-label={t('meal')}>
    {#each MEALS as m}
      <button class="chip" class:on={meal === m} aria-pressed={meal === m} onclick={() => (meal = m)}>{t(m)}</button>
    {/each}
  </div>

  {#if piece}
    <div class="unitrow" role="group" aria-label={t('pieceToggle')}>
      <button class="chip" class:on={!inPieces} aria-pressed={!inPieces} onclick={() => setMode(false)}>{unit}</button>
      <button class="chip" class:on={inPieces} aria-pressed={inPieces} onclick={() => setMode(true)}>{piece.label}</button>
      {#if editable}<button class="btn quiet-btn small" onclick={openForm} disabled={formOpen}>{t('pieceEdit')}</button>{/if}
    </div>
  {/if}
  <div class="amountrow">
    <label class="field grow">
      <span>{inPieces && piece ? t('pieceCount', { label: piece.label, g: `${fmt(piece.grams, 1)} ${unit}` }) : byPortion ? t('portionsLabel') : `${t('amount')} (${unit})`}</span>
      <input inputmode="decimal" autocomplete="off" bind:value={text} oninput={() => (touched = true)} aria-invalid={!valid && text !== ''}
        onfocus={(e) => e.currentTarget.select()} onkeydown={(e) => e.key === 'Enter' && save()} />
    </label>
    <button class="step" onclick={() => stepBy(-1)} disabled={!valid || (amount as number) <= step} aria-label={t('stepLess', { s: stepText })}>−</button>
    <button class="step" onclick={() => stepBy(1)} aria-label={t('stepMore', { s: stepText })}>+</button>
  </div>
  {#if pieceNote}<p class="note">{pieceNote}</p>{/if}
  {#if servings != null && servings !== 1 && Number.isInteger(servings * 2)}
    <p class="note">= {t('portionsN', { n: fmt(servings, 1) })}</p>
  {/if}
  <div class="quick">
    {#each quick as q}
      <button class="chip" class:on={amount === q.value} onclick={() => { touched = true; text = inputNumber(q.value); }}>{q.label}</button>
    {/each}
    {#if !byPortion && !splitOpen}
      <button class="chip quiet" onclick={openSplit}>{t('splitOpen')}</button>
    {/if}
    {#if editable && !piece && !byPortion && foodId != null && !formOpen}
      <button class="chip quiet" onclick={openForm}>{t('pieceSet')}</button>
    {/if}
  </div>

  {#if formOpen}
    <div class="piecebox">
      <p class="note">{piece ? t('pieceTitle') : `${t('pieceTitle')} ${t('pieceHelp')}`}</p>
      <div class="pieceform">
        <label class="field">
          <span>{t('pieceName')}</span>
          <input type="text" maxlength={MAX_LABEL} autocomplete="off" placeholder={t('pieceNameHint')} bind:value={formLabel}
            onkeydown={(e) => e.key === 'Enter' && savePiece()} />
        </label>
        <label class="field">
          <span>{t('pieceGrams', { unit })}</span>
          <input inputmode="decimal" autocomplete="off" bind:value={formGrams} onfocus={(e) => e.currentTarget.select()}
            onkeydown={(e) => e.key === 'Enter' && savePiece()} />
        </label>
      </div>
      {#if formError}<p class="note warn" role="alert">{formError}</p>{/if}
      <div class="pieceactions">
        <button class="btn primary small" onclick={savePiece} disabled={formBusy}>{t('pieceSave')}</button>
        <button class="btn small" onclick={() => (formOpen = false)} disabled={formBusy}>{t('cancel')}</button>
        {#if piece}<button class="btn danger small" onclick={removePiece} disabled={formBusy}>{t('pieceRemove')}</button>{/if}
      </div>
    </div>
  {/if}

  {#if splitOpen}
    <div class="piecebox">
      <p class="note">{t('splitTitle')}</p>
      <div class="splitform">
        <label class="field">
          <span>{t('splitTotal', { unit })}</span>
          <input inputmode="decimal" autocomplete="off" bind:value={splitTotal} onfocus={(e) => e.currentTarget.select()}
            onkeydown={(e) => e.key === 'Enter' && takeSplit()} />
        </label>
        <label class="field">
          <span>{t('splitParts')}</span>
          <input inputmode="decimal" autocomplete="off" bind:value={splitParts} onfocus={(e) => e.currentTarget.select()}
            onkeydown={(e) => e.key === 'Enter' && takeSplit()} />
        </label>
        <label class="field">
          <span>{t('splitEaten')}</span>
          <input inputmode="decimal" autocomplete="off" bind:value={splitEaten} onfocus={(e) => e.currentTarget.select()}
            onkeydown={(e) => e.key === 'Enter' && takeSplit()} />
        </label>
      </div>
      {#if split != null && splitOne != null}
        <p class="note">{t('splitResult', { g: `${fmt(split, 1)} ${unit}`, one: `${fmt(splitOne, 1)} ${unit}` })}</p>
      {:else if splitTotal !== ''}
        <p class="note warn">{t('splitBad')}</p>
      {/if}
      <div class="pieceactions">
        <button class="btn primary small" onclick={takeSplit} disabled={split == null}>{t('splitTake')}</button>
        <button class="btn small" onclick={() => (splitOpen = false)}>{t('cancel')}</button>
      </div>
    </div>
  {/if}

  {#if unit === 'ml' && !byPortion && foodId != null && (editable || drink != null)}
    <div class="unitrow" role="group" aria-label={t('drinkLabel')}>
      <span class="note">{t('drinkLabel')}:</span>
      {#each drinkChoices as c (c.label())}
        <button class="chip" class:on={drink === c.value} aria-pressed={drink === c.value} disabled={!editable || drinkBusy} onclick={() => setDrink(c.value)}>{c.label()}</button>
      {/each}
    </div>
    {#if drink == null}<p class="note">{t('drinkHint')}</p>{/if}
  {/if}

  <div class="result" aria-live="polite">
    <span class="big display">{kcal == null ? '–' : fmt(Math.round(kcal))}<span class="mono unit"> kcal</span></span>
    <span class="macros mono">
      <span>{t('protein')} {calc(p100.protein) == null ? '–' : fmt(calc(p100.protein) as number, 1)}</span> ·
      <span>{t('carbs')} {calc(p100.carbs) == null ? '–' : fmt(calc(p100.carbs) as number, 1)}</span> ·
      <span>{t('fat')} {calc(p100.fat) == null ? '–' : fmt(calc(p100.fat) as number, 1)} g</span>
    </span>
  </div>
  {#if p100.kcal == null}<p class="note warn">{t('noEnergy')}</p>{/if}
  {#if error}<p class="note warn" role="alert">{error}</p>{/if}

  <button class="btn primary" onclick={save} disabled={saving}>{entry ? t('saveChange') : t('saveToDiary')}</button>
  {#if entry}
    <button class="btn danger" onclick={remove} disabled={saving}>{confirming ? t('confirmDelete') : t('deleteEntry')}</button>
  {/if}
</Sheet>

<style>
  .who h3 { font-size: 18px; font-weight: 600; line-height: 1.2; }
  .meals { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; flex-shrink: 0; }
  .meals .chip { justify-content: center; }
  .quick { display: flex; flex-wrap: wrap; gap: 8px; }
  .grow { flex: 1; }
  .unitrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .unitrow .small { margin-left: auto; min-height: 44px; padding: 0 8px; font-size: 14px; }
  .chip.quiet { background: transparent; border-style: dashed; color: var(--quiet); }
  .piecebox { background: var(--paper); border-radius: 20px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
  .pieceform { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .splitform { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 10px; }
  .pieceactions { display: flex; flex-wrap: wrap; gap: 8px; }
  .pieceactions .small { min-height: 44px; padding: 0 16px; font-size: 14px; }
  .amountrow { display: flex; align-items: flex-end; gap: 8px; }
  .step { flex-shrink: 0; width: 48px; height: 48px; border-radius: 50%; border: 2px solid var(--field-line); background: var(--paper); color: inherit; font-size: 26px; line-height: 1; }
  .step:disabled { opacity: 0.4; }
  .result { background: var(--deep); color: var(--on-deep); border-radius: 28px 28px 28px 8px; padding: 16px 20px; display: flex; flex-direction: column; gap: 4px; }
  .big { font-size: 44px; line-height: 1; }
  .unit { margin-left: 6px; font-size: 14px; font-weight: 500; letter-spacing: 0; }
  .macros { font-size: 12px; color: #cfd6cc; }
  .macros span { white-space: nowrap; }
</style>
