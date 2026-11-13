<script lang="ts">
  import { untrack } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { isoWeek, mondayOfWeek, shiftDay, weekStart } from '../lib/date';
  import { t } from '../lib/i18n';
  import { ui } from '../lib/store.svelte';
  import type { Review } from '../lib/types';
  import Icon from './Icon.svelte';
  import ReviewCard from './ReviewCard.svelte';

  // The weekly review in the evaluation: a week picker (back to any earlier week, up to the last completed one).
  const lastWeek = $derived(isoWeek(shiftDay(ui.today, -7)));
  let picked = $state<string | null>(null);
  const week = $derived(picked ?? lastWeek);
  let review = $state<Review | null>(null);
  let error = $state('');
  let token = 0;

  async function load(w: string) {
    const mine = ++token;
    try {
      const r = await api.review(w);
      if (mine !== token) return;
      review = r;
      error = '';
    } catch (err) {
      if (mine !== token) return;
      error = err instanceof ApiError ? String(err.status || err.message) : 'error';
    }
  }
  $effect(() => {
    const w = week;
    ui.version;
    untrack(() => { void load(w); });
  });

  const step = (delta: number) => { picked = isoWeek(shiftDay(mondayOfWeek(week), delta * 7)); };
  const atLatest = $derived(mondayOfWeek(week) >= weekStart(shiftDay(ui.today, -7)));
</script>

<div class="panel">
  <div class="picker">
    <button class="round" onclick={() => step(-1)} aria-label={t('revPrev')}><Icon name="left" size={22} /></button>
    <button class="round" onclick={() => step(1)} disabled={atLatest} aria-label={t('revNext')}><Icon name="right" size={22} /></button>
  </div>
  {#if review}
    <ReviewCard {review} />
  {:else if error}
    <p class="note warn" role="alert">{t('revLoadFailed', { reason: error })}</p>
  {:else}
    <div class="skel" aria-hidden="true"></div>
  {/if}
</div>

<style>
  .panel { position: relative; max-width: 640px; display: flex; flex-direction: column; gap: 10px; }
  /* the week arrows sit in the card's free top right corner, so the card lines up with its neighbour */
  .picker { position: absolute; top: 16px; right: 16px; z-index: 1; display: flex; gap: 6px; }
  .round[disabled] { opacity: 0.4; cursor: default; }
  .skel { height: 300px; border-radius: 44px 14px 44px 44px; background: var(--hairline); opacity: 0.5; }
</style>
