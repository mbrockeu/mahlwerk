<script lang="ts">
  import { fmt, t } from '../lib/i18n';
  import type { InsightSleep } from '../lib/types';

  // Sleep against eating: the mean sleep, then the days after short nights (under 6 h) next to the days after nights of 7 h or
  // more: mean kcal and the distance to each day's own goal. A pattern in the data, never a cause; the text carries the numbers.
  let { sleep }: { sleep: InsightSleep | null } = $props();

  const dur = (m: number) => `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`;
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(Math.round(v / 10) * 10))}`;
  const ready = $derived(!!sleep && sleep.short.kcal != null && sleep.long.kcal != null);
  const diff = $derived(ready ? Math.round((sleep!.short.kcal! - sleep!.long.kcal!) / 10) * 10 : 0);
  const compare = $derived(
    !ready ? '' : Math.abs(diff) < 30
      ? t('sleepSame', { short: sleep!.short.days, long: sleep!.long.days })
      : t(diff > 0 ? 'sleepMore' : 'sleepLess', { n: fmt(Math.abs(diff)), short: sleep!.short.days, long: sleep!.long.days }),
  );
  const goalText = $derived(
    ready && sleep!.short.kcal_vs_goal != null && sleep!.long.kcal_vs_goal != null
      ? t('sleepGoal', { short: signed(sleep!.short.kcal_vs_goal), long: signed(sleep!.long.kcal_vs_goal) }) : '',
  );
  const bars = $derived(ready ? [
    { key: 'short', label: t('sleepShort'), g: sleep!.short, cls: 'short' },
    { key: 'long', label: t('sleepLong'), g: sleep!.long, cls: 'long' },
  ] : []);
  const top = $derived(ready ? Math.max(sleep!.short.kcal!, sleep!.long.kcal!, 1) : 1);
</script>

{#if sleep}
  <div class="sleep">
    <p class="big display">{dur(sleep.avg_minutes)}</p>
    <p class="note">{t('sleepAvg', { n: sleep.nights })}</p>
    {#if ready}
      <p class="cmp">{compare}</p>
      <ul class="bars" aria-label={t('sleepTitle')}>
        {#each bars as b (b.key)}
          <li>
            <span class="lab">{b.label} <span class="quiet">· {t('sleepDays', { n: b.g.days })}</span></span>
            <span class="track"><span class="bar {b.cls}" style="width: {(b.g.kcal! / top) * 100}%"></span></span>
            <span class="val mono">{fmt(Math.round(b.g.kcal!))} kcal</span>
          </li>
        {/each}
      </ul>
      {#if goalText}<p class="note">{goalText}</p>{/if}
    {:else}
      <p class="cmp">{t('sleepFew', { short: sleep.short.days, long: sleep.long.days, min: sleep.min_days })}</p>
    {/if}
    <p class="note">{t('sleepNote')}</p>
  </div>
{:else}
  <p class="note">{t('sleepNone')}</p>
{/if}

<style>
  .sleep { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .big { font-size: 40px; line-height: 1; }
  .cmp { font-size: 14px; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
  .bars { display: flex; flex-direction: column; gap: 10px; }
  .bars li { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; }
  .lab { font-size: 13px; grid-column: 1 / -1; }
  .track { background: var(--track); border-radius: 8px; height: 16px; overflow: hidden; }
  .bar { display: block; height: 100%; border-radius: 8px; }
  .bar.short { background: var(--orange); }
  .bar.long { background: var(--bar); }
  .val { font-size: 13px; font-weight: 600; }
</style>
