<script lang="ts" generics="T extends Pick<Food, 'name' | 'brand' | 'code' | 'per_100' | 'source'>">
  import { fmt, lang, t } from '../lib/i18n';
  import { webHost } from '../lib/portion';
  import type { Food } from '../lib/types';

  // a stored food or a catalogue product: anything with these fields can be listed
  let { food, onpick, extra, selected = false }: { food: T; onpick: (food: T) => void; extra?: string; selected?: boolean } = $props();
  // basic foods (BLS) carry an English name too
  const name = $derived((lang === 'en' && (food as { name_en?: string | null }).name_en) || food.name);
  const kcal = $derived(food.per_100.kcal == null ? '–' : `${fmt(food.per_100.kcal, 0)} kcal`);
</script>

<li>
  <button class="row-pill" class:selected aria-current={selected ? 'true' : undefined} onclick={() => onpick(food)}>
    <span class="t">
      <strong>{name || '?'}</strong>
      <small>{[food.brand, extra ?? food.code].filter(Boolean).join(' · ')}</small>
    </span>
    <span class="v">
      {kcal}
      {#if food.source === 'own'}<span class="badge">{t('own')}</span>{:else if food.source === 'recipe'}<span class="badge recipe">{t('recipeBadge')}</span>{:else if food.source === 'yazio'}<span class="badge yazio">Yazio</span>{:else if food.source === 'bls'}<span class="badge bls">BLS</span>{:else if food.source === 'cookidoo'}<span class="badge bls">Cookidoo</span>{:else if webHost(food)}<span class="badge bls">{webHost(food)}</span>{/if}
    </span>
  </button>
</li>

<style>
  .row-pill.selected { box-shadow: inset 0 0 0 2px var(--green-text); }
  .v { display: flex; align-items: center; gap: 8px; }
  .badge.recipe { background: var(--orange); color: var(--on-tile); }
  .badge.yazio, .badge.bls { background: var(--hairline); color: var(--text); }
</style>
