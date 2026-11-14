<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n';
  import { reducedMotion } from '../lib/motion.svelte';
  import { pullIntent, pullOffset, pullReady, PULL_THRESHOLD } from '../lib/pull';
  import { changed, loadMe } from '../lib/store.svelte';

  // Pull to refresh for the home-screen app only (Safari in the browser has its own). It reloads the data, never the page.
  const standalone = () =>
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;

  const MIN_SHOWN = 700; // ms the spinner stays, so that a fast answer is still seen

  let offset = $state(0); // how far the indicator is pulled down
  let phase = $state<'idle' | 'pulling' | 'busy'>('idle');
  let said = $state('');
  let sx = 0;
  let sy = 0;
  let mode: 'off' | 'wait' | 'pull' = 'off';
  let sayTimer = 0;

  /** The touch starts somewhere that has its own touch behaviour: a field, or something that scrolls. */
  function blocked(el: Element | null): boolean {
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      if (n.matches('input, textarea, select, [contenteditable], [role="slider"]')) return true;
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) return true;
      if (/(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1) return true;
    }
    return false;
  }

  function start(e: TouchEvent) {
    // only at the very top, with one finger, while nothing is loading and no sheet or dialog is open (it locks the body)
    mode = phase === 'idle' && e.touches.length === 1 && window.scrollY <= 0
      && !document.body.classList.contains('locked') && !blocked(e.target as Element)
      ? 'wait' : 'off';
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }

  function move(e: TouchEvent) {
    if (mode === 'off') return;
    if (e.touches.length !== 1 || window.scrollY > 0) { cancel(); return; }
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (mode === 'wait') {
      const intent = pullIntent(dx, dy);
      if (intent === 'wait') return;
      if (intent === 'ignore') { mode = 'off'; return; }
      mode = 'pull';
      phase = 'pulling';
    }
    // only now the page must not rubber-band as well
    if (e.cancelable) e.preventDefault();
    offset = pullOffset(dy);
  }

  function end() {
    if (mode !== 'pull') { mode = 'off'; return; }
    mode = 'off';
    if (pullReady(offset)) void refresh(); else cancel();
  }

  function cancel() {
    mode = 'off';
    offset = 0;
    phase = 'idle';
  }

  async function refresh() {
    phase = 'busy';
    offset = PULL_THRESHOLD;
    const shown = new Promise((r) => setTimeout(r, MIN_SHOWN));
    // The profile is read here (it is not a view that listens); every view that watches `ui.version` loads its data again.
    try {
      await Promise.all([loadMe(), shown]);
    } catch {
      // offline or a failed request: the views try again and show their own error; the indicator must not stay
    }
    changed();
    cancel();
    said = t('refreshed');
    clearTimeout(sayTimer);
    sayTimer = window.setTimeout(() => { said = ''; }, 2000);
  }

  onMount(() => {
    if (!standalone()) return;
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', cancel);
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', cancel);
      clearTimeout(sayTimer);
    };
  });

  const ready = $derived(phase === 'pulling' && pullReady(offset));
  const calm = reducedMotion();
</script>

<div class="sr-only" role="status" aria-live="polite">{said}</div>

{#if phase !== 'idle'}
  <div class="pull" class:calm class:snap={phase === 'busy'} style:transform="translate(-50%, {offset - 52}px)" style:opacity={Math.min(1, offset / 40)} aria-hidden="true">
    <div class="disc" class:ready class:busy={phase === 'busy'}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
        style:transform={phase === 'pulling' && !calm ? `rotate(${Math.min(180, (offset / PULL_THRESHOLD) * 180)}deg)` : undefined}>
        {#if phase === 'busy'}<path d="M12 3a9 9 0 1 0 9 9" />{:else}<path d="M12 5v14M6 13l6 6 6-6" />{/if}
      </svg>
    </div>
    <span class="micro hint">{ready ? t('pullRelease') : phase === 'busy' ? t('pullBusy') : t('pullDown')}</span>
  </div>
{/if}

<style>
  .pull { position: fixed; z-index: 35; left: 50%; top: calc(var(--safe-t) + 8px); display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none; }
  .pull.snap { transition: transform 200ms ease-out; }
  .disc {
    width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
    background: var(--paper); color: var(--green-text); border: 1px solid var(--field-line); box-shadow: 0 4px 14px rgba(23, 33, 28, 0.18);
    transition: background 160ms, color 160ms;
  }
  .disc svg { transition: transform 120ms linear; }
  .disc.ready { background: var(--lime); color: var(--on-lime); border-color: var(--lime); }
  .disc.busy svg { animation: spin 800ms linear infinite; transition: none; }
  .hint { color: var(--quiet); }
  .calm .disc svg, .calm .disc { transition: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .disc.busy svg { animation: none; } }
</style>
