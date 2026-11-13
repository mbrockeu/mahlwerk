<script lang="ts">
  import { deltaArrow } from '../lib/insightsRange';
  import { fmt, t } from '../lib/i18n';
  import type { Delta } from '../lib/types';

  // A neutral change marker against the period before: arrow, size and percentage. No red or green: the direction is
  // carried by the arrow and the words, not by a verdict.
  let { d, unit = '', digits = 0, dark = false, pct = true }: { d: Delta | null | undefined; unit?: string; digits?: number; dark?: boolean; pct?: boolean } = $props();

  const small = $derived(d ? Math.abs(d.abs) < 0.5 * 10 ** -digits : false);
  const arrow = $derived(d ? deltaArrow(small ? 0 : d.abs) : '=');
  const magnitude = $derived(d ? `${fmt(Math.abs(d.abs), digits)}${unit ? ` ${unit}` : ''}` : '');
  const percent = $derived(pct && d && d.pct != null && !small ? `${fmt(Math.abs(d.pct), Math.abs(d.pct) < 10 ? 1 : 0)} %` : '');
  const text = $derived(small ? t('deltaSame') : percent ? `${magnitude} (${percent})` : magnitude);
  const spoken = $derived(small ? t('deltaSame') : `${d && d.abs > 0 ? '+' : '−'}${magnitude}${percent ? ` (${d && d.abs > 0 ? '+' : '−'}${percent})` : ''}`);
</script>

{#if d}
  <span class="delta mono" class:dark role="note" aria-label={t('cmpAria', { text: spoken })}>
    <span aria-hidden="true">{arrow}</span><span aria-hidden="true">{text}</span>
  </span>
{/if}

<style>
  .delta {
    display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 10px 10px 10px 4px;
    font-size: 12px; font-weight: 600; white-space: nowrap; background: var(--stone); color: var(--text);
    border: 1.5px solid var(--hairline);
  }
  .delta.dark { background: color-mix(in srgb, #fff 12%, transparent); color: #fff; border-color: color-mix(in srgb, #fff 28%, transparent); }
</style>
