<script lang="ts">
  import { fromDay, weekdayInitial } from '../lib/date';
  import { fmt, lang, t } from '../lib/i18n';
  import type { BadgeCode, Review } from '../lib/types';
  import BadgeMark from './BadgeMark.svelte';
  import Icon from './Icon.svelte';

  // The weekly review as a dark card: seven day strokes, one strong point (lime), at most one idea (paper).
  let { review, ondismiss }: { review: Review; ondismiss?: () => void } = $props();

  const dm = (day: string) => new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'numeric' }).format(fromDay(day));
  const weekNo = $derived(Number(review.week.split('-W')[1]));
  const quiet = $derived(review.badges.includes('quiet_week'));
  const marks = $derived(review.badges.filter((c) => c !== 'quiet_week') as BadgeCode[]);
  const long = new Intl.DateTimeFormat(lang, { weekday: 'long' });

  const STROKE = {
    in: { h: 40, fill: '#c9f04a' }, over: { h: 40, fill: '#ffb8d6' }, under: { h: 28, fill: '#4d8a70' },
    plain: { h: 28, fill: '#4d8a70' }, none: { h: 10, fill: 'var(--tick-off)' },
  } as const;
  const look = (d: Review['days'][number]) => (!d.logged ? STROKE.none : d.state ? STROKE[d.state] : STROKE.plain);
  const stateText = (d: Review['days'][number]) =>
    !d.logged ? t('revStateNone') : d.state === 'in' ? t('revStateIn') : d.state === 'over' ? t('revStateOver') : d.state === 'under' ? t('revStateUnder') : t('revStateLogged');
  const text = (kind: 'best' | 'improve', h: { code: string; params: Record<string, number> }) =>
    t(`rev_${kind}_${h.code}` as 'rev_best_all_days', Object.fromEntries(Object.entries(h.params).map(([k, v]) => [k, fmt(v)])));
</script>

<section class="card on-dark review" aria-label={t('revTitle')}>
  <div class="head">
    <div>
      <span class="micro lime">{t('revTitle')} · {t('revWeek', { n: weekNo })}</span>
      <h2 class="display">{dm(review.from)} – {dm(review.to)}</h2>
    </div>
    {#if ondismiss}
      <button class="x" onclick={ondismiss} aria-label={t('revDismiss')}><Icon name="close" size={20} /></button>
    {/if}
  </div>

  {#if quiet}
    <p class="quiet-text">{t('rev_quiet', { n: review.logged_days })}</p>
  {:else}
    <ul class="week" aria-label={t('revDaysAria')}>
      {#each review.days as d (d.day)}
        {@const l = look(d)}
        <li aria-label={t('revDayAria', { day: long.format(fromDay(d.day)), state: stateText(d) })}>
          <span class="tk" style="height:{l.h}px; background:{l.fill}"></span>
          <span class="wd mono" aria-hidden="true">{weekdayInitial(d.day).slice(0, 2)}</span>
        </li>
      {/each}
    </ul>
    <p class="mono avg">{review.logged_days ? `${t('revAvgKcal', { kcal: fmt(review.kcal_avg) })} · ` : ''}{t('revLogged', { n: review.logged_days })}</p>

    {#if review.best}
      <div class="block best">
        <span class="micro">{t('revBest')}</span>
        <p>{text('best', review.best)}</p>
      </div>
    {/if}
    {#if review.improve}
      <div class="block improve">
        <span class="micro">{t('revImprove')}</span>
        <p>{text('improve', review.improve)}</p>
      </div>
    {/if}
    {#if !review.best && !review.improve}<p class="quiet-text">{t('revNeutral')}</p>{/if}
  {/if}

  {#if marks.length}
    <div class="marks" role="group" aria-label={t('revBadges')}>
      <span class="micro lime">{t('revBadges')}</span>
      <div>
        {#each marks as code}<span class="m"><BadgeMark {code} size={44} dark label={t(`badge_${code}`)} /></span>{/each}
      </div>
    </div>
  {/if}
</section>

<style>
  .card {
    background: var(--deep); color: var(--on-deep); border-radius: 44px 14px 44px 44px; padding: 22px 20px 20px;
    display: flex; flex-direction: column; gap: 14px; --focus: var(--lime); max-width: 640px;
  }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .lime { color: var(--lime); }
  h2 { font-size: 32px; line-height: 1.02; margin-top: 4px; }
  .x { width: 44px; height: 44px; margin: -6px -6px 0 0; border-radius: 22px; background: rgba(247, 248, 245, 0.12); color: var(--on-deep); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 8px; align-items: end; padding: 4px 6px 0; }
  .week li { display: flex; flex-direction: column; align-items: center; gap: 6px; justify-content: flex-end; }
  .tk { display: block; width: 100%; max-width: 22px; border-radius: 8px 8px 4px 4px; transform-origin: bottom; animation: rise 520ms cubic-bezier(0.2, 0.9, 0.3, 1.1) backwards; }
  .week li:nth-child(2) .tk { animation-delay: 40ms; } .week li:nth-child(3) .tk { animation-delay: 80ms; }
  .week li:nth-child(4) .tk { animation-delay: 120ms; } .week li:nth-child(5) .tk { animation-delay: 160ms; }
  .week li:nth-child(6) .tk { animation-delay: 200ms; } .week li:nth-child(7) .tk { animation-delay: 240ms; }
  .wd { font-size: 11px; color: #cfd6cc; }
  .avg { font-size: 13px; color: #e2e8df; }
  .quiet-text { font-size: 15px; color: #e2e8df; }
  .block { padding: 14px 18px 16px; display: flex; flex-direction: column; gap: 4px; }
  .block p { font-size: 16px; font-weight: 500; line-height: 1.32; }
  .best { background: var(--lime); color: var(--on-lime); border-radius: 28px 28px 8px 28px; }
  .improve { background: var(--paper); color: var(--text); border-radius: 28px 8px 28px 28px; }
  .block .micro { color: #2c3a14; }
  .improve .micro { color: var(--quiet); }
  .marks { display: flex; flex-direction: column; gap: 8px; }
  .marks div { display: flex; flex-wrap: wrap; gap: 8px; }
  .m { display: flex; }
  @keyframes rise { from { transform: scaleY(0.1); opacity: 0; } to { transform: none; opacity: 1; } }
</style>
