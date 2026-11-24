<script lang="ts">
  import { fromDay } from '../lib/date';
  import { fmt, lang, t } from '../lib/i18n';
  import { barScale } from '../lib/training';
  import type { InsightTraining } from '../lib/types';

  // Training days per calendar week as small bars (the weekly goal as a dashed line), the totals, and the logged training days
  // next to the other logged days. A pattern in the data, never a cause; the text carries the numbers, the bars are not the only signal.
  let { training }: { training: InsightTraining | null } = $props();

  const MAX_WEEKS = 26;
  const shown = $derived(training ? training.weeks.slice(-MAX_WEEKS) : []);
  const cut = $derived(!!training && training.weeks.length > MAX_WEEKS);
  const top = $derived(training ? barScale(shown, training.goal) : 3);
  const date = (day: string) => fromDay(day).toLocaleDateString(lang, { day: 'numeric', month: 'numeric' });
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(Math.round(v / 10) * 10))}`;
  const ready = $derived(!!training && training.trained.kcal != null && training.rest.kcal != null);
  const diff = $derived(ready ? Math.round((training!.trained.kcal! - training!.rest.kcal!) / 10) * 10 : 0);
  const vars = $derived(training ? { trained: training.trained.days, rest: training.rest.days } : { trained: 0, rest: 0 });
  const compare = $derived(
    !ready ? '' : Math.abs(diff) < 30 ? t('trainSame', vars) : t(diff > 0 ? 'trainMore' : 'trainLess', { ...vars, n: fmt(Math.abs(diff)) }),
  );
  const goalText = $derived(
    ready && training!.trained.kcal_vs_goal != null && training!.rest.kcal_vs_goal != null
      ? t('trainGoalCmp', { trained: signed(training!.trained.kcal_vs_goal), rest: signed(training!.rest.kcal_vs_goal) }) : '',
  );
  const bars = $derived(ready ? [
    { key: 'trained', label: t('trainDaysTrained'), g: training!.trained },
    { key: 'rest', label: t('trainDaysOther'), g: training!.rest },
  ] : []);
  const kcalTop = $derived(ready ? Math.max(training!.trained.kcal!, training!.rest.kcal!, 1) : 1);
</script>

{#if training}
  <div class="train">
    <p class="big display">{fmt(training.training_days)}</p>
    <p class="note">{t('trainTotals', { days: fmt(training.training_days), min: fmt(Math.round(training.workout_minutes)) })}</p>

    <figure class="weeks-fig">
      <figcaption class="micro quiet">{t('trainWeeksLabel')}{#if training.goal}{' · '}{t('trainGoalLine', { n: training.goal })}{/if}</figcaption>
      <ul class="weeks" aria-label={t('trainWeeksLabel')}>
        {#each shown as w (w.week_start)}
          {@const label = t('trainWeekBar', { date: date(w.week_start), n: w.training_days })}
          <li role="img" aria-label={label} title={label}>
            <span class="col"><span class="bar" class:met={training.goal != null && w.training_days >= training.goal} style="height: {(w.training_days / top) * 100}%"></span></span>
            {#if training.goal}<span class="gl" style="bottom: {(training.goal / top) * 100}%" aria-hidden="true"></span>{/if}
          </li>
        {/each}
      </ul>
      <p class="range mono" aria-hidden="true"><span>{shown.length ? date(shown[0].week_start) : ''}</span><span>{shown.length ? date(shown[shown.length - 1].week_start) : ''}</span></p>
    </figure>
    {#if cut}<p class="note">{t('trainWeeksCut', { n: MAX_WEEKS })}</p>{/if}

    {#if ready}
      <p class="cmp">{compare}</p>
      <ul class="bars" aria-label={t('trainTitle')}>
        {#each bars as b (b.key)}
          <li>
            <span class="lab">{b.label} <span class="quiet">· {t('trainDays', { n: b.g.days })}</span></span>
            <span class="track"><span class="kbar {b.key}" style="width: {(b.g.kcal! / kcalTop) * 100}%"></span></span>
            <span class="val mono">{fmt(Math.round(b.g.kcal!))} kcal</span>
          </li>
        {/each}
      </ul>
      {#if goalText}<p class="note">{goalText}</p>{/if}
    {:else}
      <p class="cmp">{t('trainFew', { ...vars, min: training.min_days })}</p>
    {/if}
    <p class="note">{t('trainNote')}</p>
  </div>
{/if}

<style>
  .train { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .big { font-size: 40px; line-height: 1; }
  .weeks-fig { display: flex; flex-direction: column; gap: 4px; margin: 4px 0 0; }
  .weeks { display: flex; gap: 3px; height: 72px; position: relative; }
  .weeks li { flex: 1 1 0; min-width: 0; max-width: 28px; position: relative; display: flex; }
  .col { display: flex; align-items: flex-end; width: 100%; height: 100%; background: var(--track); border-radius: 5px 5px 2px 2px; overflow: hidden; }
  .bar { display: block; width: 100%; background: var(--bar-soft); border-radius: 4px 4px 0 0; }
  .bar.met { background: var(--bar); }
  .gl { position: absolute; left: -2px; right: -2px; border-top: 2px dashed var(--text); pointer-events: none; }
  .range { display: flex; justify-content: space-between; font-size: 11px; color: var(--quiet); }
  .cmp { font-size: 14px; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
  .bars { display: flex; flex-direction: column; gap: 10px; }
  .bars li { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; align-items: center; }
  .lab { font-size: 13px; grid-column: 1 / -1; }
  .track { background: var(--track); border-radius: 8px; height: 16px; overflow: hidden; }
  .kbar { display: block; height: 100%; border-radius: 8px; }
  .kbar.trained { background: var(--bar); }
  .kbar.rest { background: var(--bar-soft); }
  .val { font-size: 13px; font-weight: 600; }
</style>
