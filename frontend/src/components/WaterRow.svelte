<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { api, ApiError } from '../lib/api';
  import { DEFAULT_GLASSES } from '../lib/goals';
  import { fmt, t } from '../lib/i18n';
  import { Tweened, easeOut } from '../lib/motion.svelte';
  import { toast, ui } from '../lib/store.svelte';

  // Water of one day as a row of glass strokes (one stroke = one glass), with quick buttons.
  let { day, ml: serverMl, goalMl, drinksMl = 0 }: { day: string; ml: number; goalMl: number; drinksMl?: number } = $props();

  const MAX = 10000;
  let ml = $state(untrack(() => serverMl));
  let seq = 0;
  let busy = $state(false);
  const fill = new Tweened();
  let lastDay = '';
  const sizes = $derived(ui.me?.settings?.water_glasses ?? [...DEFAULT_GLASSES]);
  let lastAdded = $state(0); // the glass added most recently in this card; the minus button takes that one back
  const back = $derived(lastAdded > 0 ? lastAdded : sizes[0]);

  // a new day or a reload: take over what the server says
  $effect(() => { const v = serverMl; day; untrack(() => { ml = v; seq += 1; busy = false; lastAdded = 0; }); });
  $effect(() => {
    const v = total;
    const d = day;
    untrack(() => {
      if (d !== lastDay) { fill.to(v, 700, easeOut, 0); lastDay = d; } else fill.to(v, 380, easeOut);
    });
  });

  const count = $derived(Math.max(4, Math.min(24, Math.round(goalMl / 250))));
  const unit = $derived(goalMl / count);
  const strokes = $derived(Array.from({ length: count }, (_, i) => Math.max(0, Math.min(1, fill.value / unit - i))));
  const litres = (v: number) => fmt(v / 1000, 2);
  // the glasses logged here plus the drinks of the diary (computed by the server): both count, the split is shown below
  const total = $derived(ml + Math.max(0, drinksMl));
  const reached = $derived(total >= goalMl);

  const pick = (size: number) => { lastAdded = size; return add(size); };
  const takeBack = () => { lastAdded = 0; return add(-back); };

  async function add(delta: number) {
    const next = Math.max(0, Math.min(MAX, ml + delta));
    if (next === ml) return;
    const before = ml;
    const mine = ++seq;
    ml = next; // optimistic: the strokes move at once
    busy = true;
    try {
      const result = await api.addWater(day, delta);
      if (mine === seq) ml = result.ml;
    } catch (err) {
      if (mine === seq) ml = before;
      toast(t('waterFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' }));
    } finally {
      if (mine === seq) busy = false;
    }
  }
</script>

<section class="water" aria-label={t('waterTitle')}>
  <div class="top">
    <span class="micro lab"><Icon name="drop" size={14} stroke={2.4} />{t('waterTitle')}</span>
    <span class="amt" aria-live="polite"><b>{litres(total)}</b> / {t('waterLitres', { n: litres(goalMl) })}</span>
  </div>
  {#if drinksMl > 0}
    <p class="split">{t('waterFromGlasses', { n: litres(ml) })} + {t('waterFromDrinks', { n: litres(drinksMl) })}</p>
  {/if}
  <div class="glasses" role="img" aria-label={t('waterAria', { ml: litres(total), goal: litres(goalMl) })} class:full={reached}>
    {#each strokes as f}<span class="g"><i style="height:{f * 100}%"></i></span>{/each}
  </div>
  <div class="btns">
    <button class="minus" disabled={ml === 0} onclick={takeBack} aria-label={t('waterTakeBackAria', { n: back })}>{t('waterTakeBack', { n: back })}</button>
    {#each sizes as size (size)}
      <button class="add" onclick={() => pick(size)} aria-label={t('waterAddAria', { n: size })}>{t(sizes.length > 2 ? 'waterAddShort' : 'waterAdd', { n: size })}</button>
    {/each}
  </div>
</section>

<style>
  .water { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 14px 14px 14px 18px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .lab { display: inline-flex; align-items: center; gap: 6px; color: var(--quiet); }
  .amt { font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--quiet); white-space: nowrap; }
  .amt b { font-size: 17px; font-weight: 600; color: var(--text); }
  .split { margin: -4px 0 0; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--quiet); }
  .glasses { display: flex; gap: 4px; height: 30px; padding-right: 4px; }
  .g { flex: 1 1 0; min-width: 0; position: relative; display: flex; align-items: flex-end; background: var(--stone); border-radius: 7px 7px 7px 3px; overflow: hidden; }
  .g i { display: block; width: 100%; background: var(--green-tick); }
  .full .g i { background: var(--green); }
  .btns { display: flex; gap: 8px; padding-right: 0; }
  .btns button { min-height: 44px; border-radius: 22px 22px 22px 8px; font-weight: 600; font-size: 14px; white-space: nowrap; }
  .add { flex: 1; background: var(--deep); color: var(--on-deep); --focus: var(--focus-base); }
  .minus { padding: 0 14px; border: 2px solid var(--field-line); color: var(--text); font-family: var(--f-mono); font-size: 13px; }
  .btns button:active:not([disabled]) { transform: scale(0.97); }
  .btns button[disabled] { opacity: 0.45; cursor: default; }
  @media (max-width: 299px) {
    .water { padding: 12px 10px 12px 12px; }
    .top { flex-wrap: wrap; gap: 2px 10px; }
    .amt { white-space: normal; }
    .btns { flex-wrap: wrap; }
    .btns button { white-space: normal; flex: 1 1 auto; padding: 4px 10px; overflow-wrap: anywhere; }
  }
  @media (min-width: 900px) { .water { justify-content: center; gap: 16px; padding: 18px 18px 18px 22px; } .glasses { height: 56px; } }
</style>
