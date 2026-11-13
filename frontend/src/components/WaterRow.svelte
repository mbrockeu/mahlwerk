<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { api, ApiError } from '../lib/api';
  import { fmt, t } from '../lib/i18n';
  import { Tweened, easeOut } from '../lib/motion.svelte';
  import { toast } from '../lib/store.svelte';

  // Water of one day as a row of glass strokes (one stroke = one glass), with quick buttons.
  let { day, ml: serverMl, goalMl }: { day: string; ml: number; goalMl: number } = $props();

  const MAX = 10000;
  let ml = $state(untrack(() => serverMl));
  let seq = 0;
  let busy = $state(false);
  const fill = new Tweened();
  let lastDay = '';

  // a new day or a reload: take over what the server says
  $effect(() => { const v = serverMl; day; untrack(() => { ml = v; seq += 1; busy = false; }); });
  $effect(() => {
    const v = ml;
    const d = day;
    untrack(() => {
      if (d !== lastDay) { fill.to(v, 700, easeOut, 0); lastDay = d; } else fill.to(v, 380, easeOut);
    });
  });

  const count = $derived(Math.max(4, Math.min(24, Math.round(goalMl / 250))));
  const unit = $derived(goalMl / count);
  const strokes = $derived(Array.from({ length: count }, (_, i) => Math.max(0, Math.min(1, fill.value / unit - i))));
  const litres = (v: number) => fmt(v / 1000, 2);
  const reached = $derived(ml >= goalMl);

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
    <span class="amt" aria-live="polite"><b>{litres(ml)}</b> / {t('waterLitres', { n: litres(goalMl) })}</span>
  </div>
  <div class="glasses" role="img" aria-label={t('waterAria', { ml: litres(ml), goal: litres(goalMl) })} class:full={reached}>
    {#each strokes as f}<span class="g"><i style="height:{f * 100}%"></i></span>{/each}
  </div>
  <div class="btns">
    <button class="minus" disabled={ml === 0} onclick={() => add(-250)} aria-label={t('waterTakeBackAria', { n: 250 })}>{t('waterTakeBack', { n: 250 })}</button>
    <button class="add" onclick={() => add(250)} aria-label={t('waterAddAria', { n: 250 })}>{t('waterAdd', { n: 250 })}</button>
    <button class="add" onclick={() => add(500)} aria-label={t('waterAddAria', { n: 500 })}>{t('waterAdd', { n: 500 })}</button>
  </div>
</section>

<style>
  .water { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 14px 14px 14px 18px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
  .lab { display: inline-flex; align-items: center; gap: 6px; color: var(--quiet); }
  .amt { font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--quiet); white-space: nowrap; }
  .amt b { font-size: 17px; font-weight: 600; color: var(--text); }
  .glasses { display: flex; gap: 4px; height: 30px; padding-right: 4px; }
  .g { flex: 1 1 0; min-width: 0; position: relative; display: flex; align-items: flex-end; background: var(--stone); border-radius: 7px 7px 7px 3px; overflow: hidden; }
  .g i { display: block; width: 100%; background: var(--green-tick); }
  .full .g i { background: var(--green); }
  .btns { display: flex; gap: 8px; padding-right: 0; }
  .btns button { min-height: 44px; border-radius: 22px 22px 22px 8px; font-weight: 600; font-size: 14px; white-space: nowrap; }
  .add { flex: 1; background: var(--deep); color: var(--on-deep); --focus: var(--focus-base); }
  .minus { padding: 0 14px; border: 2px solid var(--hairline); color: var(--text); font-family: var(--f-mono); font-size: 13px; }
  .btns button:active:not([disabled]) { transform: scale(0.97); }
  .btns button[disabled] { opacity: 0.45; cursor: default; }
  @media (min-width: 900px) { .water { justify-content: center; gap: 16px; padding: 18px 18px 18px 22px; } .glasses { height: 44px; } }
</style>
