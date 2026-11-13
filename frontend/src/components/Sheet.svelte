<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n';
  import { dragOffset, swipeDecision } from '../lib/sheetSwipe';
  import Icon from './Icon.svelte';

  let { title, onclose, children, tall = false, label }:
    { title: string; onclose: () => void; children: Snippet; tall?: boolean; label?: string } = $props();

  let sheet: HTMLDivElement;
  let backdrop: HTMLDivElement;
  let body: HTMLDivElement;
  let zone: HTMLDivElement;
  let opener: Element | null = null;

  onMount(() => {
    opener = document.activeElement;
    document.body.classList.add('locked');
    sheet.focus({ preventScroll: true });
    return () => {
      const others = document.querySelectorAll('.sheet-wrap').length;
      if (others <= 1) document.body.classList.remove('locked');
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  });

  // ---- swipe down to close (phones: below 900 px a sheet comes from the bottom; wider it is a centred dialog and has no grip) ----
  // Pointer events on the grip and the head (touch and mouse); the content follows only while it is scrolled to the very top, with touch events
  // (they may be cancelled, a pointer stream of a scrolling area may not). Inputs, sliders, selects and sideways scrolling rows never start a drag.
  const phone = () => !matchMedia('(min-width: 900px)').matches;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let startY = 0;
  let startT = 0;
  let dy = 0;
  let dragging = false;

  const place = (y: number) => {
    dy = y;
    sheet.style.transition = 'none';
    sheet.style.transform = y ? `translateY(${y}px)` : '';
    backdrop.style.opacity = String(Math.max(0.25, 1 - y / (sheet.offsetHeight * 1.2)));
  };
  /** Closing is the owner's call (it may ask first or refuse): when the sheet is still there afterwards it comes back. */
  function closeNow() {
    onclose();
    window.setTimeout(() => {
      if (!sheet?.isConnected) return;
      sheet.style.transition = reduced() ? 'none' : 'transform 240ms cubic-bezier(0.2, 0.9, 0.25, 1.1)';
      sheet.style.transform = '';
      backdrop.style.transition = '';
      backdrop.style.opacity = '';
      dy = 0;
    }, 80);
  }
  function settle() {
    const verdict = swipeDecision(dy, performance.now() - startT, sheet.offsetHeight);
    dragging = false;
    if (verdict === 'close') {
      if (reduced()) { closeNow(); return; }
      sheet.style.transition = 'transform 200ms ease-in';
      sheet.style.transform = 'translateY(100%)';
      backdrop.style.transition = 'opacity 200ms';
      backdrop.style.opacity = '0';
      window.setTimeout(closeNow, 190);
    } else {
      sheet.style.transition = reduced() ? 'none' : 'transform 240ms cubic-bezier(0.2, 0.9, 0.25, 1.1)';
      sheet.style.transform = '';
      backdrop.style.opacity = '';
      dy = 0;
    }
  }
  function zoneDown(e: PointerEvent) {
    if (!phone() || (e.pointerType === 'mouse' && e.button !== 0) || (e.target as Element).closest('button')) return;
    zone.setPointerCapture(e.pointerId);
    dragging = true;
    startY = e.clientY;
    startT = performance.now();
    dy = 0;
  }
  function zoneMove(e: PointerEvent) { if (dragging) place(dragOffset(e.clientY - startY)); }
  function zoneUp(e: PointerEvent) {
    if (!dragging) return;
    if (zone.hasPointerCapture(e.pointerId)) zone.releasePointerCapture(e.pointerId);
    if (e.type === 'pointercancel') { dy = 0; place(0); dragging = false; sheet.style.transition = ''; return; }
    settle();
  }

  /** Something in the way of a drag from the content: a field, a slider or a row that scrolls sideways. */
  function blocked(el: Element | null): boolean {
    for (let n: Element | null = el; n && n !== body; n = n.parentElement) {
      if (n.matches('input, textarea, select, [contenteditable], [role="slider"]')) return true;
      if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  }
  let tx = 0;
  let ty = 0;
  let armed = false;
  function touchStart(e: TouchEvent) {
    armed = phone() && e.touches.length === 1 && body.scrollTop <= 0 && !blocked(e.target as Element);
    dragging = false;
    tx = e.touches[0].clientX;
    ty = e.touches[0].clientY;
  }
  function touchMove(e: TouchEvent) {
    if (!armed) return;
    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    if (!dragging) {
      if (body.scrollTop > 0) { armed = false; return; }
      if (y - ty > 10 && y - ty > Math.abs(x - tx)) { dragging = true; startY = ty; startT = performance.now(); }
      else if (Math.abs(x - tx) > 10 || ty - y > 6) { armed = false; return; }
      else return;
    }
    e.preventDefault();
    place(dragOffset(y - startY));
  }
  function touchEnd() {
    if (dragging) settle();
    armed = false;
  }
  $effect(() => {
    body.addEventListener('touchstart', touchStart, { passive: true });
    body.addEventListener('touchmove', touchMove, { passive: false });
    body.addEventListener('touchend', touchEnd);
    body.addEventListener('touchcancel', touchEnd);
    return () => {
      body.removeEventListener('touchstart', touchStart);
      body.removeEventListener('touchmove', touchMove);
      body.removeEventListener('touchend', touchEnd);
      body.removeEventListener('touchcancel', touchEnd);
    };
  });

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); onclose(); return; }
    if (e.key !== 'Tab') return;
    // keep focus inside the sheet
    const items = [...sheet.querySelectorAll<HTMLElement>('button, input, select, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
</script>

<div class="sheet-wrap">
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="backdrop" bind:this={backdrop} onclick={onclose}></div>
  <div class="sheet" class:tall bind:this={sheet} role="dialog" aria-modal="true" aria-label={label ?? title} tabindex="-1" onkeydown={keydown}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="zone" bind:this={zone} onpointerdown={zoneDown} onpointermove={zoneMove} onpointerup={zoneUp} onpointercancel={zoneUp}>
      <div class="grip" aria-hidden="true"></div>
      <header>
        <h2>{title}</h2>
        <button class="round" onclick={onclose} aria-label={t('close')}><Icon name="close" size={22} /></button>
      </header>
    </div>
    <div class="body" bind:this={body}>{@render children()}</div>
  </div>
</div>

<style>
  .sheet-wrap { position: fixed; inset: 0; z-index: 30; display: flex; align-items: flex-end; justify-content: center; }
  .backdrop { position: absolute; inset: 0; background: var(--scrim); animation: fade 220ms ease-out; }
  .sheet {
    position: relative; width: 100%; max-width: 480px; max-height: 92dvh; display: flex; flex-direction: column;
    background: var(--sheet); border-radius: 36px 36px 0 0; padding: 10px 20px 0; outline: none;
    animation: rise 320ms cubic-bezier(0.2, 0.9, 0.25, 1);
    box-shadow: 0 -12px 40px rgba(23, 33, 28, 0.25), 0 0 0 1px var(--sheet-edge);
  }
  .sheet.tall { height: 92dvh; }
  /* the grip and the head are the handle: a finger there moves the sheet instead of scrolling */
  .zone { touch-action: none; user-select: none; -webkit-user-select: none; }
  .grip { width: 44px; height: 5px; border-radius: 3px; background: var(--hairline); margin: 0 auto 6px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px; }
  h2 { font-family: var(--f-display); font-weight: 800; font-size: 26px; letter-spacing: -0.03em; line-height: 1.05; min-width: 0; }
  .body { overflow-y: auto; overscroll-behavior: contain; padding: 4px 0 calc(24px + var(--safe-b)); display: flex; flex-direction: column; gap: 14px; flex: 1; }
  @keyframes rise { from { transform: translateY(100%); } to { transform: none; } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  /* wide screens: a centred dialog instead of a sheet from the bottom */
  @media (min-width: 900px) {
    .sheet-wrap { align-items: center; }
    .sheet {
      max-width: 520px; max-height: min(820px, 90dvh); border-radius: 36px; padding-top: 22px;
      animation: dialog 260ms cubic-bezier(0.2, 0.9, 0.25, 1); box-shadow: 0 24px 70px rgba(23, 33, 28, 0.35), 0 0 0 1px var(--sheet-edge);
    }
    .sheet.tall { height: min(820px, 90dvh); }
    .grip { display: none; }
    .zone { touch-action: auto; user-select: auto; }
    .body { padding-bottom: 24px; }
  }
  @keyframes dialog { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: none; } }
</style>
