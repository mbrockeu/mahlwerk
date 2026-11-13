<script lang="ts">
  import type { BadgeCode } from '../lib/types';

  // A badge as a round mark in the style of the tick scale: a ring of 40 ticks around a disc with its own glyph.
  // Earned: full ring in ink, coloured disc. Open: pale disc, the ring shows the progress.
  let { code, earned = true, progress = null, size = 72, label = '', dark = false }:
    { code: BadgeCode; earned?: boolean; progress?: { current: number; target: number } | null; size?: number; label?: string; dark?: boolean } = $props();

  const TICKS = 40;
  const TONE: Record<BadgeCode, 'lime' | 'orange' | 'pink' | 'green'> = {
    first_entry: 'lime', streak_3: 'lime', streak_7: 'green', streak_30: 'orange', streak_100: 'pink',
    scans_10: 'pink', scans_50: 'lime', first_recipe: 'orange', protein_week: 'orange', balanced_week: 'green',
    fiber_5: 'green', weigh_in_4: 'pink', full_day_10: 'lime',
  };
  const DISC = { lime: '#c9f04a', orange: '#ff8a1f', pink: '#ffb8d6', green: 'var(--green)' } as const;
  const tone = $derived(TONE[code]);
  const glyph = $derived(earned ? (tone === 'green' ? '#c9f04a' : '#17130f') : 'var(--quiet)');
  const done = $derived(earned ? TICKS : Math.round(((progress?.current ?? 0) / (progress?.target || 1)) * TICKS));
</script>

<svg viewBox="0 0 100 100" width={size} height={size} role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}>
  {#each { length: TICKS } as _, i}
    <rect x="48.4" y="1.5" width="3.2" height="8" rx="1.6" transform="rotate({(i * 360) / TICKS} 50 50)"
      fill={i < done ? (earned ? (dark ? '#f7f8f5' : 'var(--text)') : 'var(--bar)') : 'var(--hairline)'} />
  {/each}
  <circle cx="50" cy="50" r="35" fill={earned ? DISC[tone] : 'var(--paper)'} stroke={earned ? 'none' : 'var(--hairline)'} stroke-width="2" />
  <svg x="31" y="31" width="38" height="38" viewBox="0 0 24 24" fill="none" stroke={glyph} stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" opacity={earned ? 1 : 0.7}>
    {#if code === 'first_entry'}<path d="M12 3l2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3z" />
    {:else if code === 'streak_3'}<path d="M6 19v-5M12 19v-9M18 19V5" />
    {:else if code === 'streak_7'}<rect x="4" y="5" width="16" height="15" rx="3.5" /><path d="M4 10h16M9 3v4M15 3v4" />
    {:else if code === 'streak_30'}<circle cx="12" cy="12" r="8.5" stroke-dasharray="1.7 2.35" /><circle cx="12" cy="12" r="1.6" fill={glyph} />
    {:else if code === 'streak_100'}<circle cx="12" cy="12" r="8.5" /><path d="M12 12l4.2-4.2" /><circle cx="12" cy="12" r="1.3" fill={glyph} />
    {:else if code === 'scans_10'}<path d="M5 6v12M8.5 6v12M12 6v12M15.5 6v12M19 6v12" />
    {:else if code === 'scans_50'}<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9v6M12 9v6M15 9v6" />
    {:else if code === 'first_recipe'}<path d="M5 11h14v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4zM3 11h2M19 11h2M9.5 7.5c0-1.6 1-1.6 1-3.2M14 7.5c0-1.6 1-1.6 1-3.2" />
    {:else if code === 'protein_week'}<path d="M12 3.5c3.5 4.3 6 7 6 10a6 6 0 0 1-12 0c0-3 2.5-5.7 6-10z" />
    {:else if code === 'balanced_week'}<path d="M4 9h16M12 5v15M8 20h8M4 9l-2.5 5.5a3 3 0 0 0 5 0zM20 9l-2.5 5.5a3 3 0 0 0 5 0z" />
    {:else if code === 'fiber_5'}<path d="M12 21V8M12 8c-3 0-4.5-2-4.5-4.5 3 0 4.5 2 4.5 4.5zM12 8c3 0 4.5-2 4.5-4.5-3 0-4.5 2-4.5 4.5zM12 15c-3 0-4.5-2-4.5-4.5M12 15c3 0 4.5-2 4.5-4.5" />
    {:else if code === 'weigh_in_4'}<rect x="4" y="4" width="16" height="16" rx="5" /><path d="M8.5 10.5a5 5 0 0 1 7 0M12 10.5l1.6-1.6" />
    {:else if code === 'full_day_10'}<circle cx="12" cy="12" r="3.5" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18" />
    {/if}
  </svg>
</svg>

<style>
  svg { display: block; flex-shrink: 0; }
</style>
