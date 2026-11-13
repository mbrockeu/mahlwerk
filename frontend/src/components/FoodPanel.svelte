<script lang="ts">
  import { api, ApiError } from '../lib/api';
  import { imageCredit, imageUrl } from '../lib/foodImage';
  import { fmt, lang, t } from '../lib/i18n';
  import { directory, ensureNutrients, fmtAmount, GROUP_ORDER, nutrientName } from '../lib/nutrients.svelte';
  import { ROWS } from '../lib/nutrition';
  import { isPortionFood, webHost } from '../lib/portion';
  import { toast } from '../lib/store.svelte';
  import type { Food, Recipe } from '../lib/types';
  import Icon from './Icon.svelte';
  import PhotoActions from './PhotoActions.svelte';

  // The detail pane of the product list on wide screens: the values of the selected product or recipe at a glance.
  // Editing and logging open the same dialogs as everywhere else.
  // A taken-over Cookidoo recipe (source `cookidoo`) shows its values per portion (never "per 100 g": that is only how it is stored),
  // no editor, a link to the recipe at Cookidoo and, where given, reload and remove.
  // A recipe (own, Cookidoo or web) can have a picture; a picture taken over from a provider says whose it is. A recipe without one looks as it always did.
  // Narrow (a phone, a sheet, a pane below 640 px): the picture fills the top of the head block (the text never lies on it), with the photo
  // buttons on it. Wide (the content in two columns): the head block has no picture; the picture is a card of its own in the right column,
  // as high as the table of values beside it, with the source block (link, note) or the ingredients below it. The width of the panel decides, not the window.
  let { food, recipe = null, onedit, onadd, onreload, onremove, onchanged }:
    { food: Food; recipe?: Recipe | null; onedit?: () => void; onadd: () => void; onreload?: () => Promise<void>; onremove?: () => Promise<void>; onchanged?: (food: Food) => void | Promise<void> } = $props();
  const canPhoto = $derived(!!onchanged && (food.source === 'recipe' || food.source === 'cookidoo' || food.source === 'web'));
  const WIDE = 640;
  let width = $state(0);
  const wideDetail = $derived(width >= WIDE);
  const image = $derived(food.image ?? null);
  const credit = $derived(imageCredit(image));
  let photoBusy = $state(false);
  let photoFailed = $state(false);
  const hasPic = $derived(!!image && !photoFailed);
  $effect(() => { image?.hash; photoFailed = false; });
  const photoReason = (err: unknown) => (err instanceof ApiError && typeof err.detail === 'string' ? err.detail : err instanceof ApiError ? String(err.status || err.message) : 'error');
  async function setPhoto(blob: Blob) {
    photoBusy = true;
    try { const fresh = await api.setFoodImage(food.id, blob); await onchanged?.(fresh); toast(t('imgSaved')); }
    catch (err) { toast(t('imgFailed', { reason: photoReason(err) })); } finally { photoBusy = false; }
  }
  async function restorePhoto() {
    photoBusy = true;
    try { await api.restoreFoodImage(food.id); await onreload?.(); await onchanged?.(food); }
    catch (err) { toast(t('imgFailed', { reason: photoReason(err) })); } finally { photoBusy = false; }
  }
  async function dropPhoto() {
    photoBusy = true;
    try { const fresh = await api.removeFoodImage(food.id); await onchanged?.(fresh); toast(t('imgRemoved')); }
    catch (err) { toast(t('imgFailed', { reason: photoReason(err) })); } finally { photoBusy = false; }
  }
  const cook = $derived(isPortionFood(food)); // Cookidoo and web recipes: values per portion
  const host = $derived(webHost(food));
  let busy = $state(false);
  let confirming = $state(false);
  const run = async (work: () => Promise<void>) => { busy = true; try { await work(); } finally { busy = false; confirming = false; } };
  // only an http(s) address ever becomes a link (the server checks it too); a Cookidoo link is always https
  const link = $derived(cook && food.url && (food.url.startsWith('https://') || (host && food.url.startsWith('http://'))) ? food.url : null);

  void ensureNutrients();
  const name = $derived((lang === 'en' && (food as { name_en?: string | null }).name_en) || food.name || '?');
  const source = $derived(
    food.source === 'own' ? t('own') : food.source === 'recipe' ? t('recipeBadge') : food.source === 'openfoodfacts' ? t('off')
      : food.source === 'bls' ? 'BLS' : food.source === 'yazio' ? 'Yazio' : food.source === 'cookidoo' ? 'Cookidoo' : host ?? '',
  );
  const sub = (key: string) => key === 'saturated_fat' || key === 'sugars';
  const value = (key: keyof Food['per_100'], unit: string) => (food.per_100[key] == null ? '–' : `${fmt(food.per_100[key] as number, key === 'kcal' ? 0 : 1)} ${unit}`);
  const tiles = $derived([
    { key: 'protein' as const, label: t('protein'), bg: '#ff8a1f', radius: '28px 28px 8px 28px' },
    { key: 'carbs' as const, label: t('carbs'), bg: '#c9f04a', radius: '28px' },
    { key: 'fat' as const, label: t('fat'), bg: '#ffb8d6', radius: '28px 28px 28px 8px' },
  ]);
  const extras = $derived(
    GROUP_ORDER.flatMap((g) => directory.list.filter((n) => n.group === g && food.extra?.[n.key] != null))
      .map((n) => ({ key: n.key, name: nutrientName(n.key), text: fmtAmount(food.extra[n.key], n.unit) })),
  );
  const portions = $derived(recipe ? (recipe.portions === 1 ? t('portions1') : t('portionsN', { n: fmt(recipe.portions, 1) })) : '');
  const facts = $derived([food.quantity, food.serving_size ? `${t('fServing')}: ${food.serving_size}` : null, food.code].filter(Boolean) as string[]);
</script>

<div class="fp" bind:clientWidth={width}>
  <section class="hero on-dark" class:pic={hasPic && !wideDetail} aria-labelledby="fp-name">
    {#if image && hasPic && !wideDetail}
      <figure class="photo" data-testid="recipe-photo">
        <img src={imageUrl(image.hash, 'l')} alt={t('imgAlt', { name })} width="960" height="720" decoding="async" onerror={() => (photoFailed = true)} />
        {#if credit}<figcaption>{t('imgCredit', { name: credit })}</figcaption>{/if}
        {#if canPhoto}
          <div class="ptools">
            <PhotoActions tone="icon" has busy={photoBusy} onpick={setPhoto} />
            <button type="button" class="ic" disabled={photoBusy} onclick={dropPhoto} aria-label={t('imgRemove')} title={t('imgRemove')}><Icon name="close" size={20} /></button>
          </div>
        {/if}
      </figure>
    {/if}
    <span class="micro lab">{[source, recipe ? portions : cook && food.portions ? t('cookidooMakes', { n: fmt(food.portions, 1) }) : ''].filter(Boolean).join(' · ')}</span>
    <h2 id="fp-name" class="display">{name}</h2>
    {#if food.brand && !cook}<p class="brand">{food.brand}</p>{/if}
    <svg class="ticks" height="6" aria-hidden="true"><line x1="1" y1="3" x2="100%" y2="3" stroke="var(--green-tick)" stroke-width="5" stroke-linecap="round" stroke-dasharray="0.1 9" /></svg>
    <div class="big">
      {#if cook}
        <span class="num display">{food.per_100.kcal == null ? '–' : fmt(Math.round(food.per_100.kcal))}</span>
        <span class="unit">kcal · {t('perPortion')}</span>
      {:else if recipe}
        <span class="num display">{recipe.kcal_per_portion == null ? '–' : fmt(Math.round(recipe.kcal_per_portion))}</span>
        <span class="unit">kcal · {t('perPortion')}</span>
      {:else}
        <span class="num display">{food.per_100.kcal == null ? '–' : fmt(Math.round(food.per_100.kcal))}</span>
        <span class="unit">kcal · {t('per100Unit', { unit: food.unit })}</span>
      {/if}
    </div>
    <div class="acts">
      {#if cook}
        <button type="button" class="b lime" onclick={onadd}>{t('saveToDiary')}</button>
        {#if onreload}<button type="button" class="b ghost" disabled={busy} onclick={() => run(onreload)}>{busy ? t('cdReloading') : host ? t('wrReload', { host }) : t('cdReload')}</button>{/if}
        {#if onremove}
          <button type="button" class="b ghost" disabled={busy} onclick={() => (confirming ? run(onremove) : (confirming = true))}>{confirming ? t('cdRemoveConfirm') : t('cdRemove')}</button>
        {/if}
      {:else}
        <button type="button" class="b lime" onclick={onedit}>{t('detailEdit')}</button>
        <button type="button" class="b ghost" onclick={onadd}>{t('saveToDiary')}</button>
      {/if}
      {#if canPhoto && !hasPic}
        <PhotoActions has={!!image} busy={photoBusy} onpick={setPhoto} />
        {#if food.image_removed && onreload}<button type="button" class="b ghost" disabled={photoBusy} onclick={restorePhoto}>{t('imgRestore')}</button>{/if}
      {/if}
    </div>
  </section>

  <section class="tiles" aria-label={cook ? t('cdPerPortion') : t('detailPer100', { unit: food.unit })}>
    {#each tiles as tile}
      <div class="tile" style="background:{tile.bg}; border-radius:{tile.radius}">
        <span class="tl">{tile.label}</span>
        <span class="tv display">{food.per_100[tile.key] == null ? '–' : fmt(food.per_100[tile.key] as number, 1)}<span class="mono unit"> g</span></span>
      </div>
    {/each}
  </section>

  <div class="lower" class:two={!!recipe || cook || extras.length > 0} class:grid={wideDetail && (!!recipe || cook || extras.length > 0)} class:pic={wideDetail && hasPic}>
    <section class="card nut">
      <h3 class="micro quiet">{cook ? t('cdPerPortion') : t('detailPer100', { unit: food.unit })}</h3>
      <dl>
        {#each ROWS as [key, unit]}
          <div class:sub={sub(key)}><dt>{t(key)}</dt><dd class="mono">{value(key, unit)}</dd></div>
        {/each}
      </dl>
      {#if facts.length && !cook}<p class="note facts mono">{facts.join(' · ')}</p>{/if}
    </section>

    {#if wideDetail && image && hasPic}
      <figure class="card pcard" data-testid="recipe-photo">
        <img src={imageUrl(image.hash, 'l')} alt={t('imgAlt', { name })} width="960" height="720" decoding="async" onerror={() => (photoFailed = true)} />
        {#if credit}<figcaption>{t('imgCredit', { name: credit })}</figcaption>{/if}
        {#if canPhoto}
          <div class="ptools">
            <PhotoActions tone="icon" has busy={photoBusy} onpick={setPhoto} />
            <button type="button" class="ic" disabled={photoBusy} onclick={dropPhoto} aria-label={t('imgRemove')} title={t('imgRemove')}><Icon name="close" size={20} /></button>
          </div>
        {/if}
      </figure>
    {/if}

    {#if cook}
      <section class="card src">
        <h3 class="micro quiet">{host ?? 'Cookidoo'}</h3>
        <p class="note">{host ? t('wrNote', { host }) : t('cdNote')}</p>
        {#if link}<a class="open" href={link} target="_blank" rel="noopener noreferrer">{host ? t('wrOpen', { host }) : t('cdOpen')}</a>{/if}
        {#if extras.length && !wideDetail}
          <dl>{#each extras as e (e.key)}<div><dt>{e.name}</dt><dd class="mono">{e.text}</dd></div>{/each}</dl>
        {/if}
        {#if onremove}<p class="note">{t('cdRemoveNote')}</p>{/if}
      </section>
      {#if extras.length && wideDetail}
        <section class="card ext">
          <h3 class="micro quiet">{t('detailMore')}</h3>
          <dl>{#each extras as e (e.key)}<div><dt>{e.name}</dt><dd class="mono">{e.text}</dd></div>{/each}</dl>
        </section>
      {/if}
    {:else if recipe}
      <section class="card src">
        <h3 class="micro quiet">{t('rIngredients')}</h3>
        <ul class="ing">
          {#each recipe.items as it}
            <li><span>{it.name}</span><span class="mono">{fmt(it.amount, 1)} {it.unit}</span></li>
          {/each}
        </ul>
        {#if recipe.total_weight}<p class="note">{t('recipeWholeDish', { w: fmt(recipe.total_weight, 0) })}</p>{/if}
      </section>
    {:else if extras.length}
      <section class="card src">
        <h3 class="micro quiet">{t('detailMore')}</h3>
        <dl>
          {#each extras as e (e.key)}<div><dt>{e.name}</dt><dd class="mono">{e.text}</dd></div>{/each}
        </dl>
      </section>
    {/if}
  </div>
</div>

<style>
  .fp { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .hero { background: var(--green); color: #fff; border-radius: 44px 44px 44px 14px; padding: 26px 30px 24px; display: flex; flex-direction: column; gap: 8px; --focus: var(--lime); min-width: 0; }
  .lab { color: var(--lime); }
  /* the picture fills the top of the head block edge to edge; its lower corners are uneven like everything else here, and no text lies on it */
  .hero.pic { padding-top: 0; }
  .photo { margin: 0 -30px 14px; position: relative; aspect-ratio: 4 / 3; background: var(--green-deep); border-radius: 44px 44px 10px 36px; overflow: hidden; }
  .photo img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .photo figcaption { position: absolute; left: 14px; bottom: 12px; max-width: calc(100% - 28px); padding: 3px 10px; border-radius: 10px 10px 10px 4px; background: var(--paper); color: var(--text); font-family: var(--f-mono); font-size: 11px; letter-spacing: 0.06em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ptools { position: absolute; top: 16px; right: 16px; display: flex; gap: 8px; }
  .ic { width: 44px; height: 44px; border-radius: 16px 16px 16px 6px; background: var(--paper); color: var(--text); display: inline-flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(23, 33, 28, 0.18); }
  .ic:disabled { opacity: 0.6; }
  h2 { font-size: clamp(30px, 2.6vw, 44px); line-height: 1.02; overflow-wrap: anywhere; }
  .brand { color: #d5ead0; font-size: 15px; }
  .ticks { width: 100%; margin: 6px 0 2px; }
  .big { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  .num { font-size: clamp(64px, 6vw, 92px); line-height: 1; letter-spacing: -0.04em; }
  .unit { font-family: var(--f-mono); font-size: 14px; font-weight: 500; color: var(--on-deep); }
  .acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .b { min-height: 46px; padding: 0 22px; border-radius: 24px 24px 24px 8px; font-weight: 700; font-size: 15px; }
  .b.lime { background: var(--lime); color: var(--on-lime); }
  .b:disabled { opacity: 0.6; }
  .open { align-self: flex-start; min-height: 44px; display: inline-flex; align-items: center; padding: 0 20px; border-radius: 22px 22px 22px 8px; font-weight: 700; font-size: 15px; background: var(--lime); color: var(--on-lime); text-decoration: none; }
  .b.ghost { background: transparent; color: #fff; box-shadow: inset 0 0 0 2px var(--green-tick); }
  .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .tile { height: 104px; color: var(--on-tile); padding: 14px 16px; display: flex; flex-direction: column; justify-content: space-between; }
  .tl { font-size: 13px; font-weight: 600; }
  .tv { font-size: 38px; line-height: 1; }
  .tv .unit { font-size: 13px; color: inherit; }
  .lower { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; align-items: start; }
  .card { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 18px 22px 18px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  dl { margin: 0; }
  dl > div { display: flex; justify-content: space-between; gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--hairline); font-size: 15px; }
  dl > div:last-child { border-bottom: 0; }
  dl > div.sub { padding-left: 16px; font-size: 14px; color: var(--quiet); }
  dt { min-width: 0; }
  dd { margin: 0; font-weight: 600; white-space: nowrap; }
  .facts { margin-top: 4px; }
  .ing { display: flex; flex-direction: column; }
  .ing li { display: flex; justify-content: space-between; gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--hairline); font-size: 15px; }
  .ing li:last-child { border-bottom: 0; }
  .ing .mono { font-weight: 600; white-space: nowrap; }
  /* wide panel: the values on the left, the right column holds the picture card (as high as the values) and below it the source or the ingredients */
  .lower.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-areas: 'nut src' 'ext .'; }
  .lower.grid.pic { grid-template-areas: 'nut pic' 'ext src'; }
  .nut { grid-area: nut; }
  .src { grid-area: src; }
  .ext { grid-area: ext; }
  .card.pcard { grid-area: pic; align-self: stretch; position: relative; padding: 0; min-height: 240px; overflow: hidden; margin: 0; background: var(--green-deep); border-radius: 28px 28px 8px 28px; }
  .card.pcard img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
  .card.pcard figcaption { position: absolute; left: 14px; bottom: 12px; max-width: calc(100% - 28px); padding: 3px 10px; border-radius: 10px 10px 10px 4px; background: var(--paper); color: var(--text); font-family: var(--f-mono); font-size: 11px; letter-spacing: 0.06em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (min-width: 1800px) {
    /* a single table uses the width in two columns */
    .lower:not(.two) dl { columns: 2; column-gap: 48px; }
    .lower:not(.two) dl > div { break-inside: avoid; }
  }
</style>
