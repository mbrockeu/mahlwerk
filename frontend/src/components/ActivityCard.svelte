<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import NumField from './NumField.svelte';
  import TickBar from './TickBar.svelte';
  import { api, ApiError } from '../lib/api';
  import { shiftDay, weekdayInitial, weekdayLong, weekStart } from '../lib/date';
  import { fmt, t } from '../lib/i18n';
  import { changed, openWorkout, toast } from '../lib/store.svelte';
  import { clock, kindInfo } from '../lib/workouts';
  import type { ActivitySource, DayActivity, Workout } from '../lib/types';

  // The movement of one day: steps against the goal as a tick scale, active energy, and the workouts as rows.
  // Steps and active energy can be corrected by tapping the number (the value then counts as typed by hand).
  let { day, activity }: { day: string; activity: DayActivity } = $props();

  let steps = $state(untrack(() => activity.steps));
  let energy = $state(untrack(() => activity.active_kcal));
  let seq = 0;
  // a new day or a reload: take over what the server says
  $effect(() => { const s = activity.steps; const e = activity.active_kcal; day; untrack(() => { steps = s; energy = e; seq += 1; }); });

  const goal = $derived(activity.steps_goal);
  const reached = $derived(steps != null && steps >= goal);
  const SOURCE_KEY = { manual: 'actSrcManual', health: 'actSrcHealth', yazio: 'actSrcYazio', demo: 'actSrcDemo' } as const satisfies Record<ActivitySource, string>;
  const sourceText = $derived(activity.source == null ? '' : t(SOURCE_KEY[activity.source]));
  const km = $derived(activity.distance_m ? fmt(activity.distance_m / 1000, activity.distance_m >= 10000 ? 0 : 1) : '');

  async function save(values: { steps?: number; active_kcal?: number }) {
    const mine = ++seq;
    const before = { steps, energy };
    if (values.steps !== undefined) steps = values.steps;
    if (values.active_kcal !== undefined) energy = values.active_kcal;
    try {
      await api.setActivity(day, values);
      if (mine === seq) changed();
    } catch (err) {
      if (mine === seq) { steps = before.steps; energy = before.energy; }
      toast(t('actSaveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' }));
    }
  }

  // the week row: only with a weekly goal; seven dots Monday to Sunday (filled = training day, the shown day has a ring)
  const week = $derived(activity.week ?? null);
  const monday = $derived(weekStart(day));
  const weekDays = $derived(week ? week.days.map((on, i) => { const d = shiftDay(monday, i); return { d, on, shown: d === day, name: weekdayLong(d), ini: weekdayInitial(d) }; }) : []);
  const weekText = $derived(week ? t('trainWeekRow', { done: week.done, goal: week.goal }) : '');

  const kindName = (w: Workout) => (w.kind === 'other' && w.name ? w.name : t(`wk_${w.kind}`));
  const detail = (w: Workout) =>
    [t('actMin', { n: fmt(Math.round(w.minutes)) }), w.started_at ? clock(w.started_at) : '', w.distance_m ? t('actKm', { n: fmt(w.distance_m / 1000, 1) }) : '']
      .filter(Boolean).join(' · ');
  const kcalText = (w: Workout) => t(w.kcal_estimated ? 'actKcalEst' : 'actKcal', { n: fmt(Math.round(w.kcal)) });
</script>

<section class="act" aria-labelledby="act-title">
  <div class="top">
    <h2 id="act-title" class="micro lab"><Icon name="steps" size={15} stroke={2.4} />{t('actTitle')}</h2>
    <div class="tr">
      {#if sourceText}<span class="src mono" title={t('actSource', { source: sourceText })}>{sourceText}</span>{/if}
      <!-- wide screens: the add button moves up here, so the card is not much taller than the water card beside it -->
      <button class="addw-s" onclick={() => openWorkout({ day, workout: null })}><Icon name="plus" size={16} stroke={2.6} />{t('actAddWorkout')}</button>
    </div>
  </div>

  <div class="steps">
    <div class="numline">
      <span class="num display">
        <NumField class="edit" value={steps ?? 0} min={0} max={200000} label={t('actEditSteps')} onset={(v) => save({ steps: v })} />
      </span>
      <span class="of mono">{t('actStepsOfGoal', { goal: fmt(goal) })}</span>
      {#if reached}<span class="done mono"><Icon name="check" size={14} stroke={3} />{t('actGoalReached')}</span>{/if}
    </div>
    <TickBar value={steps ?? 0} {goal} track="var(--track)" fill="var(--bar)" height={16}
      label={t('actStepsAria', { steps: fmt(steps ?? 0), goal: fmt(goal) })} />
  </div>

  <dl class="facts">
    <div class="fact">
      <dt class="micro quiet">{t('actActive')}</dt>
      <dd class="mono"><NumField class="edit" value={energy ?? 0} min={0} max={20000} label={t('actEditActive')} onset={(v) => save({ active_kcal: v })} /><span class="u"> kcal</span></dd>
    </div>
    {#if km}
      <div class="fact">
        <dt class="micro quiet">{t('actDistance')}</dt>
        <dd class="mono">{km}<span class="u"> km</span></dd>
      </div>
    {/if}
  </dl>
  {#if week}
    <div class="week" role="group" aria-label={t('trainWeekAria', { done: week.done, goal: week.goal })}>
      <p class="wtext"><span>{weekText}</span>
        {#if week.done >= week.goal}<span class="wok mono"><Icon name="check" size={13} stroke={3} />{t('trainWeekReached')}</span>{/if}
        {#if week.streak >= 2}<span class="wstreak mono">{t('trainWeekStreak', { n: week.streak })}</span>{/if}
      </p>
      <ul class="dots">
        {#each weekDays as w (w.d)}
          <li class:on={w.on} class:shown={w.shown} title={w.name}>
            <span class="dot" aria-hidden="true"></span>
            <span class="ini mono" aria-hidden="true">{w.ini}</span>
            <span class="sr-only">{t(w.on ? 'trainDayOn' : 'trainDayOff', { day: w.name })}{w.shown ? `, ${t('trainDayShown')}` : ''}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if activity.steps == null && activity.active_kcal == null && !activity.workouts.length}<p class="note">{t('actNoValue')}</p>{/if}

  {#if activity.workouts.length}<ul class="workouts" aria-label={t('actWorkoutsToday')}>
    {#each activity.workouts as w (w.id)}
      <li>
        <button class="wrow" onclick={() => openWorkout({ day, workout: w })}
          aria-label={t('actWorkoutAria', { kind: kindName(w), minutes: fmt(Math.round(w.minutes)), kcal: kcalText(w) })}>
          <span class="ico" aria-hidden="true"><Icon name={kindInfo(w.kind).icon} size={22} /></span>
          <span class="t"><strong>{kindName(w)}</strong><small>{detail(w)}</small></span>
          <span class="v mono">{kcalText(w)}</span>
        </button>
      </li>
    {/each}
  </ul>{/if}
  <button class="addw" onclick={() => openWorkout({ day, workout: null })}>
    <Icon name="plus" size={20} stroke={2.4} />{t('actAddWorkout')}
  </button>
</section>

<style>
  .act { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 14px 14px 14px 18px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .lab { display: inline-flex; align-items: center; gap: 6px; color: var(--quiet); font-weight: 500; }
  .src { font-size: 11px; color: var(--quiet); background: var(--stone); border-radius: 8px; padding: 3px 8px; white-space: nowrap; }

  .steps { display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
  .numline { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
  .num { font-size: 48px; line-height: 1; letter-spacing: -0.04em; }
  .num :global(.edit) { padding: 4px 0 2px; border-bottom: 3px dotted var(--green-tick); border-radius: 0; }
  .of { font-size: 13px; color: var(--quiet); }
  .done { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; background: var(--lime); color: var(--on-lime); border-radius: 10px 10px 10px 4px; padding: 2px 9px; }

  .facts { display: flex; flex-wrap: wrap; gap: 4px 28px; padding-right: 4px; }
  .fact { display: flex; flex-direction: column; gap: 0; min-width: 0; }
  .fact dd { margin: 0; min-height: 44px; font-size: 20px; font-weight: 600; display: flex; align-items: center; }
  .fact dd :global(.edit) { padding: 8px 0 1px; border-bottom: 2px dotted var(--hairline); border-radius: 0; }
  .u { font-size: 12px; font-weight: 500; color: var(--quiet); margin-left: 2px; }

  .week { display: flex; flex-direction: column; gap: 6px; padding-right: 4px; }
  .wtext { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 14px; font-weight: 600; }
  .wok { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; font-weight: 600; background: var(--lime); color: var(--on-lime); border-radius: 10px 10px 10px 4px; padding: 1px 8px; }
  .wstreak { font-size: 12px; color: var(--quiet); }
  .dots { display: flex; gap: 6px; }
  .dots li { flex: 1 1 0; max-width: 40px; display: flex; flex-direction: column; align-items: center; gap: 2px; position: relative; }
  .dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--hairline); box-sizing: border-box; }
  .dots li.on .dot { background: var(--bar); border-color: var(--bar); }
  .dots li.shown .dot { box-shadow: 0 0 0 2px var(--paper), 0 0 0 4px var(--text); }
  .ini { font-size: 10px; color: var(--quiet); }
  .dots li.shown .ini { color: var(--text); font-weight: 600; }
  .workouts { display: flex; flex-direction: column; gap: 6px; }
  .wrow { width: 100%; min-height: 56px; padding: 6px 14px 6px 8px; border-radius: 20px 20px 20px 8px; background: var(--stone); display: flex; align-items: center; gap: 12px; text-align: left; }
  .ico { width: 40px; height: 40px; border-radius: 14px 14px 14px 6px; background: var(--lime); color: var(--on-lime); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .t { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .t strong { font-size: 15px; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t small { font-size: 12px; color: var(--quiet); font-family: var(--f-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .v { font-size: 14px; font-weight: 600; white-space: nowrap; }
  .addw {
    min-height: 48px; border-radius: 24px 24px 24px 8px; background: var(--deep); color: var(--on-deep); font-weight: 600; font-size: 14px;
    display: flex; align-items: center; justify-content: center; gap: 8px; --focus: var(--focus-base); margin-right: 4px;
  }
  .wrow:active, .addw:active { transform: scale(0.985); }
  .tr { display: flex; align-items: center; gap: 8px; }
  .addw-s {
    display: none; min-height: 36px; padding: 0 14px 0 10px; border-radius: 18px 18px 18px 6px; background: var(--deep); color: var(--on-deep);
    font-weight: 600; font-size: 13px; align-items: center; gap: 6px; white-space: nowrap; --focus: var(--focus-base);
  }
  .addw-s:active { transform: scale(0.97); }
  @media (min-width: 900px) {
    .act { padding: 18px 18px 18px 22px; gap: 10px; }
    .num { font-size: 40px; }
    .addw { display: none; }
    .addw-s { display: inline-flex; }
    .fact dd, .fact dd :global(.edit) { min-height: 36px; }
  }
  @media (prefers-reduced-motion: reduce) { .wrow:active, .addw:active, .addw-s:active { transform: none; } }
</style>
