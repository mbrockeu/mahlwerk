<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { shrink } from '../lib/image';
  import { inputNumber, parseNumber, t } from '../lib/i18n';
  import { directory, ensureNutrients, GROUP_ORDER, nutrientName } from '../lib/nutrients.svelte';
  import { ROWS } from '../lib/nutrition';
  import { changed, ui, type EditorRequest } from '../lib/store.svelte';
  import type { Extra, FoodIn, NutrientInfo, Per100 } from '../lib/types';
  import Sheet from './Sheet.svelte';

  let { req }: { req: EditorRequest } = $props();

  // the editor is re-created for every request ({#key} in App), so reading `req` once is intended
  // svelte-ignore state_referenced_locally
  const food = req.food;
  // svelte-ignore state_referenced_locally
  const code = req.code ?? food?.code ?? null;
  // svelte-ignore state_referenced_locally
  const onSaved = req.onSaved;

  let name = $state(food?.name ?? '');
  let brand = $state(food?.brand ?? '');
  let quantity = $state(food?.quantity ?? '');
  let serving = $state(food?.serving_size ?? '');
  let unit = $state<'g' | 'ml'>(food?.unit ?? 'g');
  let values = $state<Record<string, string>>(Object.fromEntries(ROWS.map(([k]) => [k, inputNumber(food?.per_100[k])])));
  // additional nutrients: text per directory key; the section stays closed as long as nothing is filled in
  let extraValues = $state<Record<string, string>>(Object.fromEntries(Object.entries(food?.extra ?? {}).map(([k, v]) => [k, inputNumber(v)])));
  let extraOpen = $state(Object.keys(food?.extra ?? {}).length > 0);
  const extraGroups = $derived(GROUP_ORDER
    .map((group) => ({ group, items: directory.list.filter((n) => n.group === group) }))
    .filter((g) => g.items.length));
  void ensureNutrients();
  let invalid = $state<Record<string, boolean>>({});
  let status = $state('');
  let statusWarn = $state(false);
  let warnings = $state<string[]>([]);
  let rawText = $state('');
  let saving = $state(false);
  let reading = $state(false);
  let confirming = $state(false);
  let nameInput: HTMLInputElement;

  const close = () => { ui.editor = null; };
  const failMsg = (err: unknown) => t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });

  async function readLabel(file: File) {
    reading = true;
    status = t('reading');
    statusWarn = false;
    warnings = [];
    try {
      const scan = await api.labelScan(await shrink(file));
      let recognised = 0;
      for (const [key] of ROWS) {
        const v = scan.per_100[key];
        if (v != null) { values[key] = inputNumber(v); recognised += 1; }
      }
      status = recognised ? t('readDone', { n: recognised }) : t('readNothing');
      statusWarn = !recognised;
      warnings = recognised ? scan.warnings : [];
      rawText = scan.text;
    } catch (err) {
      status = t('readFailed', { reason: err instanceof ApiError ? err.status || err.message : (err as Error).message });
      statusWarn = true;
    } finally {
      reading = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    invalid = {};
    const per_100: Partial<Per100> = {};
    for (const [key] of ROWS) {
      const v = parseNumber(values[key]);
      if (Number.isNaN(v)) invalid[key] = true;
      per_100[key] = v;
    }
    if (!name.trim()) { status = t('nameRequired'); statusWarn = true; nameInput.focus(); return; }
    const extra: Extra = {};
    for (const n of directory.list) {
      const v = parseNumber(extraValues[n.key] ?? '');
      if (v === null) continue; // empty: unknown, not sent
      if (Number.isNaN(v)) invalid[n.key] = true; else extra[n.key] = v;
    }
    const bad = ROWS.find(([k]) => invalid[k]) ?? directory.list.find((n: NutrientInfo) => invalid[n.key]);
    if (bad) {
      status = t('badNumber'); statusWarn = true;
      if (!Array.isArray(bad)) extraOpen = true;
      const id = Array.isArray(bad) ? bad[0] : bad.key;
      setTimeout(() => document.getElementById(`e-${id}`)?.focus());
      return;
    }
    const body: FoodIn = {
      name: name.trim(), brand: brand.trim() || null, quantity: quantity.trim() || null,
      serving_size: serving.trim() || null, unit, per_100, extra,
    };
    saving = true;
    try {
      const saved = code ? await api.putFoodByBarcode(code, body) : food?.id ? await api.updateFood(food.id, body) : await api.createFood(body);
      ui.editor = null;
      changed();
      onSaved?.(saved);
    } catch (err) {
      status = failMsg(err);
      statusWarn = true;
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!food?.id) return;
    if (!confirming) { confirming = true; return; }
    saving = true;
    try {
      await api.deleteFood(food.id);
      ui.editor = null;
      changed();
    } catch (err) {
      status = failMsg(err);
      statusWarn = true;
      confirming = false;
    } finally {
      saving = false;
    }
  }
</script>

<Sheet title={food ? t('editTitle') : t('newTitle')} onclose={close} tall>
  {#if code}<p class="mono quiet code">{code}</p>{/if}
  {#if req.notice}<p class="note">{req.notice}</p>{/if}

  <label class="btn lime photo" class:busy={reading}>
    <input type="file" accept="image/*" capture="environment" class="sr-only"
      onchange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void readLabel(f); }} />
    {t('photo')}
  </label>
  <p class="note" class:warn={statusWarn} role="status">{status}</p>
  {#if warnings.length}
    <ul class="warnings">{#each warnings as w}<li>{t(`w_${w}`)}</li>{/each}</ul>
  {/if}

  <form onsubmit={submit}>
    <label class="field"><span>{t('fName')}</span><input bind:this={nameInput} bind:value={name} required maxlength="200" autocomplete="off" /></label>
    <label class="field"><span>{t('fBrand')}</span><input bind:value={brand} maxlength="200" autocomplete="off" /></label>
    <div class="pair">
      <label class="field"><span>{t('fQuantity')}</span><input bind:value={quantity} maxlength="60" autocomplete="off" placeholder="500 g" /></label>
      <label class="field"><span>{t('fServing')}</span><input bind:value={serving} maxlength="60" autocomplete="off" placeholder="30 g" /></label>
    </div>
    <label class="field"><span>{t('fUnit')}</span>
      <select bind:value={unit}><option value="g">g</option><option value="ml">ml</option></select>
    </label>

    <p class="micro quiet">{t('per100')}</p>
    <div class="values">
      {#each ROWS as [key, u, indent]}
        <label class="field" class:indent>
          <span>{t(key)} ({u})</span>
          <input id="e-{key}" inputmode="decimal" autocomplete="off" bind:value={values[key]} aria-invalid={invalid[key] ? 'true' : undefined} />
        </label>
      {/each}
    </div>

    <details class="more" bind:open={extraOpen}>
      <summary>{t('moreNutrients')}</summary>
      <p class="note">{t('moreNutrientsHint', { unit })}</p>
      {#each extraGroups as g (g.group)}
        <p class="micro quiet group">{t(`grp_${g.group}`)}</p>
        <div class="values">
          {#each g.items as n (n.key)}
            <label class="field">
              <span>{nutrientName(n.key)} ({n.unit})</span>
              <input id="e-{n.key}" inputmode="decimal" autocomplete="off" bind:value={extraValues[n.key]} aria-invalid={invalid[n.key] ? 'true' : undefined} />
            </label>
          {/each}
        </div>
      {/each}
    </details>

    {#if rawText}
      <details><summary>{t('rawText')}</summary><pre>{rawText}</pre></details>
    {/if}

    <button class="btn primary" disabled={saving}>{t('save')}</button>
    <button type="button" class="btn" onclick={close}>{t('cancel')}</button>
    {#if food?.id}
      <button type="button" class="btn danger" onclick={remove} disabled={saving}>{confirming ? t('confirmRemove') : t('remove')}</button>
    {/if}
    <p class="note">{t('ownHint')}</p>
  </form>
</Sheet>

<style>
  .code { font-size: 12px; letter-spacing: 0.08em; }
  .photo { position: relative; cursor: pointer; }
  .photo:focus-within { outline: 3px solid var(--focus); outline-offset: 2px; }
  .photo.busy { opacity: 0.6; }
  form { display: flex; flex-direction: column; gap: 12px; }
  .pair, .values { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .field.indent span { padding-left: 10px; }
  .warnings { background: var(--paper); border-left: 6px solid var(--orange); border-radius: 8px 20px 20px 8px; padding: 12px 16px; display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: var(--warn); }
  details { font-size: 13px; }
  summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-weight: 600; }
  .more { background: var(--paper); border-radius: 20px 20px 20px 8px; padding: 0 16px; font-size: 14px; }
  .more[open] { padding-bottom: 16px; display: flex; flex-direction: column; gap: 10px; }
  .more .group { margin-top: 12px; }
  .more .values { gap: 10px; }
  .more .field input { background: var(--stone); }
  pre { white-space: pre-wrap; background: var(--paper); border-radius: 12px; padding: 10px; font-size: 12px; margin: 0; }
</style>
