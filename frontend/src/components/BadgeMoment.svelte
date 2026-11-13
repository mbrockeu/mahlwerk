<script lang="ts">
  import { onMount } from 'svelte';
  import { Tweened, easeOut } from '../lib/motion.svelte';
  import { t } from '../lib/i18n';
  import type { BadgeCode } from '../lib/types';
  import BadgeMark from './BadgeMark.svelte';

  // A short celebration for newly reached badges: the mark springs in, the ticks of the ring run round once (1.2 s).
  // With reduced motion the ring is simply there and everything fades in.
  let { codes, ondone }: { codes: BadgeCode[]; ondone: () => void } = $props();

  const TICKS = 48;
  const R = 92;
  const STEP = (2 * Math.PI * R) / TICKS;
  const run = new Tweened();
  const filled = $derived(Math.round(run.value * TICKS));
  const maskLength = $derived(filled === 0 ? 0 : filled * STEP - 4.1);
  const first = $derived(codes[0]);
  const rest = $derived(codes.slice(1));
  let button: HTMLButtonElement;
  let opener: Element | null = null;

  onMount(() => {
    opener = document.activeElement;
    run.to(1, 1200, easeOut, 0);
    button.focus({ preventScroll: true });
    return () => { run.stop(); if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true }); };
  });
  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); ondone(); }
    else if (e.key === 'Tab') { e.preventDefault(); button.focus(); }
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="wrap">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="scrim" onclick={ondone}></div>
  <div class="card on-dark moment-card" role="dialog" aria-modal="true" aria-labelledby="moment-title">
    <span class="micro eyebrow" id="moment-title">{codes.length === 1 ? t('momentTitle1') : t('momentTitleN', { n: codes.length })}</span>
    <div class="stage">
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <mask id="moment-mask"><circle cx="100" cy="100" r={R - 8} fill="none" stroke="#fff" stroke-width="24"
            stroke-dasharray="{maskLength} 600" transform="rotate(-90 100 100)" /></mask>
        </defs>
        <circle cx="100" cy="100" r={R - 8} fill="none" stroke="var(--tick-off)" stroke-width="12" stroke-dasharray="3 {STEP - 3}" transform="rotate(-90 100 100)" />
        <circle cx="100" cy="100" r={R - 8} fill="none" stroke="#c9f04a" stroke-width="12" stroke-dasharray="3 {STEP - 3}" transform="rotate(-90 100 100)" mask="url(#moment-mask)" />
      </svg>
      <div class="mark"><BadgeMark code={first} size={124} dark /></div>
    </div>
    <h2 class="display">{t(`badge_${first}`)}</h2>
    <p class="cond">{t(`badgeCond_${first}`)}</p>
    {#if rest.length}
      <div class="more" role="group" aria-label={t('momentMore', { names: rest.map((c) => t(`badge_${c}`)).join(', ') })}>
        {#each rest as c}<span class="mini"><BadgeMark code={c} size={44} dark /></span>{/each}
        <span class="note names">{t('momentMore', { names: rest.map((c) => t(`badge_${c}`)).join(', ') })}</span>
      </div>
    {/if}
    <button class="btn lime" bind:this={button} onclick={ondone}>{t('momentDone')}</button>
  </div>
</div>

<style>
  .wrap { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .scrim { position: absolute; inset: 0; background: var(--scrim-strong); animation: fade 240ms ease-out; }
  .card {
    position: relative; width: min(340px, 100%); background: var(--deep); color: var(--on-deep); border-radius: 44px 44px 44px 14px; padding: 24px 22px 22px;
    display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; --focus: var(--lime);
    animation: card-in 360ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
  }
  .eyebrow { color: var(--lime); }
  .stage { position: relative; width: 200px; height: 200px; margin: 2px 0; }
  .stage svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .mark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; animation: spring-in 760ms cubic-bezier(0.2, 1.5, 0.4, 1) 120ms backwards; }
  h2 { font-size: 30px; line-height: 1.02; }
  .cond { font-size: 14px; color: #d9dfd6; max-width: 26ch; }
  .more { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; margin-top: 4px; }
  .mini { display: flex; }
  .names { flex-basis: 100%; color: #d9dfd6; }
  .btn { margin-top: 10px; width: 100%; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes card-in { from { opacity: 0; transform: translateY(24px) scale(0.94); } to { opacity: 1; transform: none; } }
  @keyframes spring-in { 0% { opacity: 0; transform: translateY(-90px) scale(0.3) rotate(-18deg); } 60% { opacity: 1; } 100% { opacity: 1; transform: none; } }
</style>
