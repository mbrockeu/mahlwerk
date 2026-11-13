<script lang="ts">
  import { untrack } from 'svelte';
  import { Tweened, easeOut } from '../lib/motion.svelte';

  // Straight tick scale: 15 ticks of 3 units in a 90-unit wide box (the grinder dial, unrolled).
  let { value, goal, track, fill = '#17130f', label, height = 10, delay = 0 }:
    { value: number; goal: number | null; track: string; fill?: string; label: string; height?: number; delay?: number } = $props();

  const p = new Tweened();
  const target = $derived(goal ? Math.min(value / goal, 1) : 0);
  $effect(() => {
    const to = target;
    untrack(() => {
      if (delay > 0 && p.value === 0) setTimeout(() => p.to(to, 700, easeOut), delay);
      else p.to(to, 700, easeOut);
    });
  });
  const ticks = $derived.by(() => {
    const n = Math.round(p.value * 15);
    return n === 0 && p.value > 0.001 ? 1 : n;
  });
  const w = $derived(ticks * 6 - 3);
</script>

<svg width="100%" {height} viewBox="0 0 90 10" preserveAspectRatio="none" role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}>
  <path d="M0 5H90" stroke={track} stroke-width="8" stroke-dasharray="3 3" />
  {#if ticks > 0}<path d="M0 5H{w}" stroke={fill} stroke-width="8" stroke-dasharray="3 3" />{/if}
</svg>
