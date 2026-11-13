<script lang="ts">
  // "Take over from a link" (a sheet of the recipes page): the address of a recipe page goes in, the server fetches that ONE page and
  // reads what it publishes for search engines (schema.org Recipe). The preview shows name, portions, values per portion and the source,
  // plus the ingredient lines to look at (they are never saved), and warnings where something looks off. Name and portions can be
  // corrected, and "the values are for the whole recipe" divides them by the portions. Without nutrition values nothing is taken over
  // (it would count as 0 kcal); the person can start an own recipe from the name and portions instead.
  import { onDestroy } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, inputNumber, parseNumber, t } from '../lib/i18n';
  import type { Food, WebPreview } from '../lib/types';
  import Toggle from './Toggle.svelte';

  let { onadopt, onown, group = null }: {
    onadopt: (food: Food, updated: boolean) => void;
    onown: (draft: { name: string; portions: number | null; ingredients: string[]; host: string }) => void;
    /** A group id: the recipe goes into it. */
    group?: number | null;
  } = $props();

  let link = $state('');
  let preview = $state<WebPreview | null>(null);
  let name = $state('');
  let portionsText = $state('');
  let whole = $state(false);
  let looking = $state(false);
  let adopting = $state(false);
  let error = $state('');
  let token = 0;
  let timer = 0;

  const why = (err: unknown) => {
    if (!(err instanceof ApiError)) return t('wrE_other', { reason: 'error' });
    const detail = typeof err.detail === 'string' ? err.detail : '';
    if (err.status === 429) return t('wrE_busy');
    if (err.status === 502) return t('wrE_unreachable');
    if (err.status === 404) return t('wrE_off');
    if (err.status === 422) {
      if (detail.includes('no recipe data')) return t('wrE_norecipe');
      if (detail.includes('not a web page')) return t('wrE_nothtml');
      if (detail.includes('too large')) return t('wrE_toolarge');
      if (detail.includes('not a web address')) return t('wrE_address');
      if (detail.length) return detail;
    }
    return t('wrE_other', { reason: err.status || err.message });
  };

  const portionsN = $derived(portionsText.trim() === '' ? null : parseNumber(portionsText));
  const portionsOk = $derived(portionsN == null || (!Number.isNaN(portionsN) && portionsN > 0 && portionsN <= 200));
  const typedPortions = $derived(portionsN != null && !Number.isNaN(portionsN) && portionsN > 0 ? portionsN : null);

  // fetch (or, for the same address, re-read from the server's short memory) with the person's corrections
  async function read(address: string, fresh: boolean) {
    const mine = ++token;
    looking = true;
    error = '';
    try {
      const result = await api.webRecipePreview({ url: address, whole, portions: fresh ? null : typedPortions, name: fresh ? undefined : name.trim() || undefined });
      if (mine !== token) return;
      preview = result;
      if (fresh) {
        name = result.name;
        portionsText = result.portions == null ? '' : inputNumber(result.portions);
        whole = false;
      }
    } catch (err) {
      if (mine !== token) return;
      error = why(err);
      if (fresh) preview = null;
    } finally {
      if (mine === token) looking = false;
    }
  }
  function lookup(event: SubmitEvent) {
    event.preventDefault();
    const text = link.trim();
    if (!text || looking) return;
    preview = null;
    whole = false;
    void read(text, true);
  }
  // a changed number of portions or the switch asks the server again (it answers from memory, no new fetch)
  function recompute(delay = 0) {
    clearTimeout(timer);
    if (!preview || !portionsOk) return;
    const address = preview.url;
    timer = window.setTimeout(() => { void read(address, false); }, delay);
  }
  onDestroy(() => { clearTimeout(timer); token += 1; });

  const blocked = $derived(!preview ? null : !name.trim() ? 'no_name' : preview.blocked === 'no_name' ? null : preview.blocked);
  const message = (code: NonNullable<WebPreview['blocked']>) => t(`wrB_${code}`);
  const hasEnergy = $derived(preview?.per_portion.kcal != null);
  const show = (v: number | null | undefined, digits = 1) => (v == null ? '–' : fmt(v, digits));
  const tiles = $derived([
    { key: 'protein' as const, label: t('protein'), bg: '#ff8a1f', radius: '24px 24px 8px 24px' },
    { key: 'carbs' as const, label: t('carbs'), bg: '#c9f04a', radius: '24px' },
    { key: 'fat' as const, label: t('fat'), bg: '#ffb8d6', radius: '24px 24px 24px 8px' },
  ]);

  async function takeOver() {
    if (!preview || adopting || blocked || !portionsOk) return;
    adopting = true;
    error = '';
    try {
      const updated = preview.food_id != null;
      const food = await api.webRecipeAdopt({ url: preview.url, whole, portions: typedPortions, name: name.trim(), ...(group != null ? { group_id: group } : {}) });
      onadopt(food, updated);
    } catch (err) { error = why(err); } finally { adopting = false; }
  }
  const startOwn = () => {
    if (preview) onown({ name: name.trim(), portions: typedPortions ?? preview.page_portions, ingredients: preview.ingredients, host: preview.host });
  };
</script>

<div class="wr">
  <p class="note">{t('wrIntro')}</p>
  <form class="lookup" onsubmit={lookup}>
    <label class="field"><span>{t('wrLinkLabel')}</span>
      <input bind:value={link} inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="2000" placeholder="https://" />
    </label>
    <p class="note">{t('wrAddrHint')}</p>
    <button class="btn primary" disabled={looking || !link.trim()}>{looking && !preview ? t('wrReading') : t('wrLookup')}</button>
  </form>

  {#if error}<p class="note warn" role="alert">{error}</p>{/if}

  {#if preview}
    <section class="preview" aria-label={t('wrReadingAria')} aria-busy={looking}>
      <span class="micro host">{t('wrHostTag', { host: preview.host })}</span>
      <label class="field"><span>{t('wrName')}</span><input bind:value={name} maxlength="200" autocomplete="off" aria-invalid={!name.trim() ? 'true' : undefined} /></label>
      <div class="pair">
        <label class="field short"><span>{t('wrPortions')}</span>
          <input inputmode="decimal" autocomplete="off" bind:value={portionsText} oninput={() => recompute(450)} aria-invalid={portionsOk ? undefined : 'true'} />
        </label>
        {#if preview.page_portions != null && preview.portions !== preview.page_portions}
          <p class="note grow">{t('wrPageSays', { n: fmt(preview.page_portions, 2) })}</p>
        {/if}
      </div>
      <Toggle checked={whole} label={t('wrWhole')} sub={t('wrWholeHint')} disabled={looking} onchange={() => { whole = !whole; recompute(0); }} />

      {#if hasEnergy}
        <div class="values" role="group" aria-label={t('wrPerPortionValues')}>
          <p class="big"><span class="num display">{fmt(Math.round(preview.per_portion.kcal ?? 0))}</span><span class="unit mono">kcal · {t('perPortion')}</span></p>
          <div class="tiles">
            {#each tiles as tile}
              <div class="tile" style="background:{tile.bg}; border-radius:{tile.radius}"><span class="tl">{tile.label}</span><span class="tv display">{show(preview.per_portion[tile.key])}<span class="mono"> g</span></span></div>
            {/each}
          </div>
          <p class="mono more">
            {t('saturated_fat')} {show(preview.per_portion.saturated_fat)} · {t('sugars')} {show(preview.per_portion.sugars)} · {t('fiber')} {show(preview.per_portion.fiber)} · {t('salt')} {show(preview.per_portion.salt, 2)} g
          </p>
          {#if preview.serving_size}<p class="note">{t('wrServing', { s: preview.serving_size })}</p>{/if}
        </div>
      {/if}

      {#if preview.warnings.length}
        <ul class="checks">
          {#each preview.warnings as w (w)}<li><span class="micro tag">{t('wrCheck')}</span><span>{t(`wrW_${w}`)}</span></li>{/each}
        </ul>
      {/if}
      {#if blocked}<p class="note warn" role="status">{message(blocked)}</p>{/if}
      {#if preview.food_id != null && !blocked}<p class="note">{t('wrOnList')}</p>{/if}

      {#if preview.ingredients.length}
        <details>
          <summary>{t('wrIngredients')} <small>({fmt(preview.ingredients.length)})</small></summary>
          <ul class="ing">{#each preview.ingredients as line}<li>{line}</li>{/each}</ul>
        </details>
      {/if}

      <div class="acts">
        <button type="button" class="btn lime" onclick={takeOver} disabled={adopting || !!blocked || !portionsOk || looking}>{preview.food_id != null ? t('wrUpdate') : t('wrTake')}</button>
        {#if blocked === 'no_energy' || !hasEnergy}
          <button type="button" class="btn" onclick={startOwn} disabled={!name.trim()}>{t('wrOwn')}</button>
        {/if}
      </div>
      {#if blocked === 'no_energy' || !hasEnergy}<p class="note">{t('wrOwnHint')}</p>{/if}
    </section>
  {/if}
</div>

<style>
  .wr { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .lookup { display: flex; flex-direction: column; gap: 8px; }
  .preview { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 18px 18px 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .host { color: var(--quiet); overflow-wrap: anywhere; }
  .pair { display: flex; gap: 12px; align-items: flex-end; }
  .short { width: 112px; flex-shrink: 0; }
  .grow { flex: 1; min-width: 0; padding-bottom: 12px; }
  .values { display: flex; flex-direction: column; gap: 10px; }
  .big { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .num { font-size: 56px; line-height: 1; letter-spacing: -0.04em; }
  .unit { font-size: 13px; color: var(--quiet); }
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .tile { min-height: 84px; color: var(--on-tile); padding: 12px 8px 12px 10px; display: flex; flex-direction: column; justify-content: space-between; }
  .tl { font-size: 11.5px; font-weight: 600; letter-spacing: -0.01em; overflow-wrap: break-word; }
  @media (max-width: 430px) { .tl { font-size: 10.5px; letter-spacing: -0.02em; } .tile { padding: 12px 6px 12px 9px; } }
  @media (max-width: 374px) { .tl { overflow-wrap: anywhere; } }
  .tv { font-size: 30px; line-height: 1; }
  .tv .mono { font-size: 12px; }
  .more { font-size: 12px; color: var(--quiet); line-height: 1.5; }
  .checks { display: flex; flex-direction: column; gap: 6px; }
  .checks li { display: flex; gap: 10px; align-items: baseline; font-size: 14px; line-height: 1.4; }
  .tag { flex-shrink: 0; padding: 2px 8px; border-radius: 10px; background: var(--warn); color: var(--paper); }
  details { background: var(--stone); border-radius: 20px; padding: 4px 8px; }
  summary { min-height: 44px; display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; cursor: pointer; padding: 0 8px; }
  summary small { color: var(--quiet); font-weight: 500; }
  .ing { padding: 0 8px 10px; display: flex; flex-direction: column; gap: 4px; max-height: 32vh; overflow-y: auto; }
  .ing li { font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
  .acts { display: flex; gap: 8px; flex-wrap: wrap; }
  input[aria-invalid='true'] { border-color: var(--warn); }
</style>
