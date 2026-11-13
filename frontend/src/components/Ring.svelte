<script lang="ts">
  import { untrack } from 'svelte';
  import { Tweened, easeOut, spring } from '../lib/motion.svelte';
  import { fmt, t } from '../lib/i18n';

  let { eaten, goal, day }: { eaten: number; goal: number | null; day: string } = $props();

  const TICKS = 48;
  const R = 86;
  const STEP = (2 * Math.PI * R) / TICKS; // 11.257: one 3-unit tick plus its gap

  const progress = new Tweened();
  const shown = new Tweened();
  let lastDay = '';

  const over = $derived(goal != null && eaten > goal);
  const target = $derived(goal ? Math.abs(goal - eaten) : eaten);

  $effect(() => {
    const p = goal ? Math.min(eaten / goal, 1) : 0;
    const n = Math.round(target);
    const d = day;
    untrack(() => {
      if (d !== lastDay) {
        // opening a day: the dial fills tick by tick and the number counts up
        progress.to(p, 700, easeOut, 0);
        shown.to(n, 700, easeOut, 0);
        lastDay = d;
      } else {
        // after a new entry: advance from the old position, the pointer overshoots a little
        progress.to(p, 650, spring);
        shown.to(n, 500, easeOut);
      }
    });
  });

  const filled = $derived(Math.max(0, Math.min(TICKS, Math.round(progress.value * TICKS))));
  const maskLength = $derived(filled === 0 ? 0 : filled * STEP - 4.1);
  const angle = $derived(-Math.PI / 2 + 2 * Math.PI * Math.max(0, Math.min(1.02, progress.value)));
  const px = $derived(100 + R * Math.cos(angle));
  const py = $derived(100 + R * Math.sin(angle));

  const aria = $derived(
    goal
      ? t('ringAria', {
          eaten: fmt(eaten), goal: fmt(goal),
          rest: over ? t('restOver', { n: fmt(eaten - goal) }) : t('restLeft', { n: fmt(goal - eaten) }),
        })
      : t('ringAriaNoGoal', { eaten: fmt(eaten) }),
  );
  const label = $derived(!goal ? t('kcalEaten') : over ? t('kcalOver') : t('kcalLeft'));
</script>

<div class="ring">
  <svg viewBox="0 0 200 200" role="img" aria-label={aria}>
    <defs>
      <mask id="ring-mask"><circle cx="100" cy="100" r={R} fill="none" stroke="#fff" stroke-width="24"
        stroke-dasharray="{maskLength} 541" transform="rotate(-90 100 100)" /></mask>
    </defs>
    <circle cx="100" cy="100" r={R} fill="none" stroke="#4d8a70" stroke-width="18" stroke-dasharray="3 {STEP - 3}" transform="rotate(-90 100 100)" />
    <circle cx="100" cy="100" r={R} fill="none" stroke="#c9f04a" stroke-width="18" stroke-dasharray="3 {STEP - 3}" transform="rotate(-90 100 100)" mask="url(#ring-mask)" />
    <circle cx="100" cy="100" r="68" fill="#174a36" />
    {#if goal}
      <circle cx={px} cy={py} r="8" fill={over ? '#ffb8d6' : '#ff8a1f'} stroke="#1d5c43" stroke-width="3" />
    {/if}
  </svg>
  <div class="center" aria-hidden="true">
    <span class="num" class:long={fmt(Math.round(shown.value)).length > 3}>{fmt(Math.round(shown.value))}</span>
    <span class="lab">{label}</span>
  </div>
</div>

<style>
  .ring { position: relative; width: 196px; height: 196px; flex-shrink: 0; }
  svg { width: 100%; height: 100%; display: block; }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 34px; }
  .num { font-family: var(--f-display); font-size: 62px; font-weight: 800; letter-spacing: -0.05em; line-height: 0.95; }
  .num.long { font-size: 46px; letter-spacing: -0.04em; }
  .lab { font-size: 13px; font-weight: 600; color: #e2f4c0; line-height: 1.15; margin-top: 2px; }
  @media (max-width: 359px) {
    .ring { width: 160px; height: 160px; }
    .num { font-size: 50px; }
  }
</style>
