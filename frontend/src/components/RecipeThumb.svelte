<script lang="ts">
  // The small picture of a recipe in a list row (`m`, 44 px) or among the suggestions (`s`, the same box, a little smaller). The box has a
  // fixed size whether or not there is a picture, so a list never jumps while pictures arrive. Without a picture (or when the file is
  // gone) it shows a quiet stand-in: a few ticks of the grinder dial and the first letter of the name. Decorative: the name stands beside it.
  import { imageUrl, initial } from '../lib/foodImage';
  import type { Food } from '../lib/types';

  let { food, size = 'm', blank = true }: { food: Pick<Food, 'image' | 'name'>; size?: 'm' | 's'; blank?: boolean } = $props();
  let failed = $state(false);
  const hash = $derived(food.image?.hash ?? null);
  $effect(() => { hash; failed = false; });
  const letter = $derived(initial(food.name));
</script>

{#if hash && !failed}
  <span class="thumb {size}" aria-hidden="true"><img src={imageUrl(hash, size)} alt="" width="44" height="44" loading="lazy" decoding="async" onerror={() => (failed = true)} /></span>
{:else if blank}
  <span class="thumb {size} ph" aria-hidden="true">
    <svg viewBox="0 0 44 44" focusable="false">
      <path d="M9.5 31.5A15.5 15.5 0 1 1 34.5 31.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 5.4" />
    </svg>
    {#if letter}<b class="display">{letter}</b>{/if}
  </span>
{/if}

<style>
  .thumb { position: relative; flex: none; width: 44px; height: 44px; border-radius: 16px 16px 16px 6px; overflow: hidden; background: var(--thumb-bg, var(--stone)); display: block; }
  .thumb.s { width: 40px; height: 40px; border-radius: 14px 14px 14px 5px; }
  img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .ph { color: var(--hairline); display: flex; align-items: center; justify-content: center; }
  .ph svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .thumb.s b { font-size: 17px; }
  .ph b { position: relative; font-size: 19px; line-height: 1; color: var(--quiet); letter-spacing: -0.02em; margin-top: 1px; }
</style>
