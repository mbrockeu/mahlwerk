<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { t } from '../lib/i18n';
  import { findTarget, placeBubble, spotlight, STEPS, stepFrom, type Placement, type Rect, type StepDef } from '../lib/tour';
  import { ui } from '../lib/store.svelte';

  // The first-run tour: a dark veil with a hole around a real element of the day view and a speech bubble beside it.
  // Phone and desktop keep some things in different places, so a step lists the selectors to try (first visible wins);
  // a step without a visible target is skipped.
  let { ondone }: { ondone: () => void } = $props();

  type Def = StepDef & { title: () => string; text: () => string };
  const TEXT: Record<string, { title: () => string; text: () => string }> = {
    ring: { title: () => t('tourRingTitle'), text: () => t(ui.me?.goal ? 'tourRingText' : 'tourRingTextNoGoal') },
    macros: { title: () => t('tourMacrosTitle'), text: () => t('tourMacrosText') },
    meal: { title: () => t('tourMealTitle'), text: () => t('tourMealText') },
    scan: { title: () => t('tourScanTitle'), text: () => t('tourScanText') },
    history: { title: () => t('tourHistoryTitle'), text: () => t('tourHistoryText') },
    menu: { title: () => t('tourMenuTitle'), text: () => t('tourMenuText') },
    profile: { title: () => t('tourProfileTitle'), text: () => t('tourProfileText') },
  };
  const DEFS: Def[] = STEPS.map((step) => ({ ...step, ...TEXT[step.id] }));

  const visible = (el: Element) => el.getClientRects().length > 0;
  const targetOf = (def: Def) => findTarget(def, (s) => document.querySelector(s), visible);
  const resolve = () => DEFS.filter((d) => targetOf(d)).map((d) => d.id);

  let ids = $state<string[]>(resolve());
  let cur = $state<string | null>(stepFrom(resolve(), null, 1));
  const def = $derived(DEFS.find((d) => d.id === cur) ?? null);
  const index = $derived(cur ? ids.indexOf(cur) : 0);
  const last = $derived(index >= ids.length - 1);

  let vp = $state({ w: window.innerWidth, h: window.innerHeight });
  let hole = $state<Rect | null>(null);
  let holeRadius = $state('24px');
  let box: HTMLDivElement;
  let size = $state({ w: 340, h: 200 });
  let place = $state<Placement>({ left: 16, top: 16, side: 'center', arrow: 0 });
  let nextBtn: HTMLButtonElement | undefined = $state();
  let ready = $state(false);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** Measure the current target (and bring it into view first), then lay out hole and bubble. */
  function measure(scroll: boolean) {
    vp = { w: window.innerWidth, h: window.innerHeight };
    const next = resolve();
    if (next.join() !== ids.join()) ids = next;
    if (!next.length) { ondone(); return; }
    if (cur && !next.includes(cur)) cur = stepFrom(next, cur, 1) ?? next[next.length - 1];
    const el = def ? targetOf(def) : null;
    if (!el) { hole = null; return; }
    if (scroll && !el.closest('nav')) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el), pad = 8;
    const corner = (v: string) => Math.min(parseFloat(v) + pad || 24, (r.height + 2 * pad) / 2, 40);
    holeRadius = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => `${corner(v)}px`).join(' ');
    hole = spotlight({ left: r.left, top: r.top, width: r.width, height: r.height }, vp);
  }
  $effect(() => { void cur; untrack(() => measure(true)); void tick().then(() => { size = { w: box.offsetWidth, h: box.offsetHeight }; }); });
  $effect(() => { place = placeBubble(hole, size, vp); });
  $effect(() => { void cur; void tick().then(() => { nextBtn?.focus({ preventScroll: true }); ready = true; }); });

  onMount(() => {
    const opener = document.activeElement;
    const startY = window.scrollY;
    const inertTargets = [...document.querySelectorAll<HTMLElement>('main, nav, [data-menu]')];
    inertTargets.forEach((el) => el.setAttribute('inert', ''));
    let raf = 0;
    const again = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { measure(false); size = { w: box.offsetWidth, h: box.offsetHeight }; }); };
    window.addEventListener('resize', again);
    window.addEventListener('orientationchange', again);
    window.addEventListener('scroll', again, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', again);
      window.removeEventListener('orientationchange', again);
      window.removeEventListener('scroll', again, true);
      inertTargets.forEach((el) => el.removeAttribute('inert'));
      window.scrollTo({ top: startY, behavior: 'auto' });
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  });

  const go = (dir: 1 | -1) => {
    const n = stepFrom(ids, cur, dir);
    if (n) cur = n; else if (dir === 1) ondone();
  };

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ondone(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); return; }
    if (e.key !== 'Tab') return;
    const items = [...box.querySelectorAll<HTMLElement>('button:not([disabled])')];
    if (!items.length) return;
    const first = items[0], end = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); end.focus(); }
    else if (!e.shiftKey && document.activeElement === end) { e.preventDefault(); first.focus(); }
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="tour" class:ready>
  <div class="veil" aria-hidden="true"></div>
  {#if hole}
    <div class="hole" aria-hidden="true"
      style="left:{hole.left}px; top:{hole.top}px; width:{hole.width}px; height:{hole.height}px; border-radius:{holeRadius}"></div>
  {/if}
  <div class="bubble {place.side}" bind:this={box} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text"
    aria-label={t('tourAria')} tabindex="-1" style="left:{place.left}px; top:{place.top}px; --arrow:{place.arrow}px; width:min(340px, {vp.w - 32}px)">
    <div class="meta">
      <svg class="scale" width={ids.length * 9.5 - 2.5} height="14" viewBox="0 0 {ids.length * 9.5 - 2.5} 14" aria-hidden="true">
        {#each ids as id, i}
          <rect x={i * 9.5} y={i === index ? 0 : 3} width="4" height={i === index ? 14 : 8} rx="2" fill={i <= index ? 'var(--bar)' : 'var(--track)'} />
        {/each}
      </svg>
      <span class="micro quiet">{t('tourStepOf', { n: index + 1, total: ids.length })}</span>
    </div>
    <div aria-live="polite">
      <h2 id="tour-title" class="display">{def?.title()}</h2>
      <p id="tour-text">{def?.text()}</p>
    </div>
    <div class="acts">
      {#if !last}<button type="button" class="btn quiet-btn skip" onclick={ondone}>{t('tourSkip')}</button>{/if}
      <span class="grow"></span>
      {#if index > 0}<button type="button" class="btn back" onclick={() => go(-1)}>{t('tourBack')}</button>{/if}
      <button type="button" class="btn primary" bind:this={nextBtn} onclick={() => go(1)}>{last ? t('tourDone') : t('tourNext')}</button>
    </div>
  </div>
</div>

<style>
  .tour { position: fixed; inset: 0; z-index: 60; --focus: var(--focus-base); }
  /* a transparent layer that swallows clicks; the darkness comes from the hole's shadow */
  .veil { position: absolute; inset: 0; }
  .hole {
    position: absolute; box-shadow: 0 0 0 9999px var(--scrim-strong), 0 0 0 3px var(--lime) inset; pointer-events: none;
  }
  .ready .hole, .ready .bubble { transition: left 240ms cubic-bezier(0.2, 0.9, 0.25, 1), top 240ms cubic-bezier(0.2, 0.9, 0.25, 1), width 240ms, height 240ms; }
  .bubble {
    position: absolute; background: var(--paper); color: var(--text); border-radius: 28px 28px 28px 8px; padding: 16px 18px 14px;
    display: flex; flex-direction: column; gap: 10px; outline: none; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35), 0 0 0 1px var(--sheet-edge);
  }
  .bubble::after {
    content: ''; position: absolute; width: 16px; height: 16px; background: var(--paper); border-radius: 3px; display: none;
  }
  .bubble.top::after, .bubble.bottom::after { display: block; left: calc(var(--arrow) - 8px); transform: rotate(45deg); }
  .bubble.bottom::after { top: -7px; }
  .bubble.top::after { bottom: -7px; }
  .bubble.left::after, .bubble.right::after { display: block; top: calc(var(--arrow) - 8px); transform: rotate(45deg); }
  .bubble.right::after { left: -7px; }
  .bubble.left::after { right: -7px; }
  .meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .scale { flex-shrink: 0; }
  h2 { font-size: 24px; line-height: 1.08; }
  p { margin-top: 6px; font-size: 15px; line-height: 1.4; color: var(--text); }
  .acts { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .grow { flex: 1; }
  .acts .btn { min-height: 44px; padding: 0 18px; }
  .acts .quiet-btn { padding: 0 8px; margin-left: -8px; font-weight: 500; color: var(--quiet); }
  @media (max-width: 359px) { .acts { flex-wrap: wrap; } }
</style>
