<script lang="ts">
  import { markerPath, SERIES_STYLES } from '../lib/nutrientCompare';

  // The sample of one line of the comparison: its dash pattern and its marker, in its colour. Used by chips, rows and legend.
  let { i, hollow = false, width = 30 }: { i: number; hollow?: boolean; width?: number } = $props();
  const s = $derived(SERIES_STYLES[i % SERIES_STYLES.length]);
</script>

<svg {width} height="16" viewBox="0 0 {width} 16" aria-hidden="true" class="mark">
  <path d="M2 8H{width - 2}" stroke={s.color} stroke-width={hollow ? 1.8 : 3} stroke-dasharray={s.dash} stroke-linecap="round" opacity={hollow ? 0.6 : 1} />
  <path d={markerPath(s.shape, width / 2, 8, 4.2)} fill={hollow ? 'var(--paper)' : s.color} stroke={s.color} stroke-width="1.8" stroke-linejoin="round" />
</svg>

<style>.mark { display: block; flex-shrink: 0; overflow: visible; }</style>
