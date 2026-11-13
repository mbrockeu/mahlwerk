<script lang="ts">
  import { fmt, t } from '../lib/i18n';
  import type { Expenditure, Goal } from '../lib/types';

  // The estimated real expenditure: one number with its range, one sentence of how it comes about, the distance to the goal.
  let { exp, missing, goal }: { exp: Expenditure | null; missing: string[]; goal: Goal | null } = $props();

  let width = $state(300);
  const H = 76, PX = 10, Y = 40;
  const lo = $derived(exp ? Math.floor((Math.min(exp.low, goal?.kcal ?? exp.low) - 150) / 100) * 100 : 0);
  const hi = $derived(exp ? Math.ceil((Math.max(exp.high, goal?.kcal ?? exp.high) + 150) / 100) * 100 : 1);
  const x = (v: number) => PX + ((width - PX * 2) * (v - lo)) / Math.max(hi - lo, 1);
  const gap = $derived(exp?.goal_gap ?? null);
  const gapText = $derived(gap == null ? '' : Math.abs(gap) < 50 ? t('expGapSame') : gap < 0 ? t('expGapBelow', { n: fmt(Math.round(Math.abs(gap) / 10) * 10) }) : t('expGapAbove', { n: fmt(Math.round(gap / 10) * 10) }));
  const signed = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), d)}`;
  const how = $derived(exp ? t('expHow', { intake: fmt(exp.intake), change: signed(exp.weight_change_kg), perWeek: signed(exp.kg_per_week, 2), kcal: fmt(Math.round(exp.kcal / 10) * 10) }) : '');
  const aria = $derived(exp ? t('expAria', { kcal: fmt(exp.kcal), low: fmt(exp.low), high: fmt(exp.high), gap: gapText ? `. ${gapText}` : '' }) : '');
</script>

{#if exp}
  <div class="exp" bind:clientWidth={width}>
    <p class="big display">{fmt(Math.round(exp.kcal / 10) * 10)}<small class="mono"> {t('expPerDay')}</small></p>
    <p class="range mono">{t('expRange', { low: fmt(Math.round(exp.low / 10) * 10), high: fmt(Math.round(exp.high / 10) * 10) })}</p>
    <svg {width} height={H} viewBox="0 0 {width} {H}" role="img" aria-label={aria}>
      <path d="M{x(lo)} {Y}H{x(hi)}" stroke="var(--track)" stroke-width="16" stroke-dasharray="3 3" />
      <path d="M{x(exp.low)} {Y}H{x(exp.high)}" stroke="var(--bar)" stroke-width="16" stroke-dasharray="3 3" />
      <circle cx={x(exp.kcal)} cy={Y} r="9" fill="var(--orange)" stroke="var(--paper)" stroke-width="3" />
      {#if goal}
        <path d="M{x(goal.kcal)} {Y - 17}V{Y + 17}" stroke="var(--text)" stroke-width="2.5" stroke-linecap="round" />
        <text x={Math.min(Math.max(x(goal.kcal), PX + 24), width - PX - 24)} y="12" text-anchor="middle" class="lab strong">{t('expScaleGoal')} {fmt(goal.kcal)}</text>
      {/if}
      <text x={x(exp.kcal)} y={H - 4} text-anchor="middle" class="lab strong">{fmt(exp.kcal)}</text>
      <text x={PX} y={H - 4} text-anchor="start" class="lab">{fmt(lo)}</text>
      <text x={width - PX} y={H - 4} text-anchor="end" class="lab">{fmt(hi)}</text>
    </svg>
    <p class="how">{how}</p>
    {#if goal}<p class="gap">{gapText}</p>{:else}<p class="note">{t('expNoGoal')}</p>{/if}
    <p class="note">{t('expNote')}</p>
  </div>
{:else}
  <div class="exp">
    <p class="miss-title">{t('expMissingTitle')}</p>
    <p class="note">{t('expMissingIntro')}</p>
    <ul class="missing">
      {#each missing as m (m)}<li>{t(`expMissing_${m}` as 'expMissing_short_period')}</li>{/each}
    </ul>
    <p class="note">{t('expNote')}</p>
  </div>
{/if}

<style>
  .exp { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .big { font-size: 48px; line-height: 1; }
  .big small { font-size: 14px; font-weight: 500; letter-spacing: 0; margin-left: 4px; }
  .range { font-size: 13px; font-weight: 600; }
  svg { display: block; overflow: visible; }
  .lab { font-family: var(--f-mono); font-size: 11px; fill: var(--quiet); }
  .lab.strong { fill: var(--text); font-weight: 600; }
  .how { font-size: 14px; line-height: 1.45; }
  .gap { font-size: 14px; font-weight: 600; }
  .miss-title { font-family: var(--f-display); font-weight: 800; font-size: 22px; letter-spacing: -0.03em; line-height: 1.1; }
  .missing { display: flex; flex-direction: column; gap: 6px; }
  .missing li { background: var(--stone); border-radius: 16px 16px 16px 6px; padding: 9px 14px; font-size: 14px; }
</style>
