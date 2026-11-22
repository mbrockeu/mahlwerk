<script lang="ts">
  import { t } from '../lib/i18n';
  import { INSIGHTS_HELP, scrollTarget } from '../lib/help';
  import { reducedMotion } from '../lib/motion.svelte';
  import { navigate, router } from '../lib/router.svelte';
  import { resetTour, ui } from '../lib/store.svelte';
  import Sheet from './Sheet.svelte';

  // The help (menu, rail, evaluation page): the tour of the day view, then every card of the evaluation – what it shows,
  // what it needs, and on the evaluation page a jump to it. Cards not on the page right now (nothing logged in the period)
  // are still explained, with a note instead of the jump. Elsewhere one button leads to the evaluation.
  const tx = (key: string, p?: Record<string, string>) => t(key as 'hlpOpen', p);
  const onInsights = router.route === 'history';
  // which targets exist is read once when the sheet opens; the page behind does not change while it is open
  const present = new Set(onInsights ? INSIGHTS_HELP.filter((e) => e.target && document.getElementById(e.target)).map((e) => e.target as string) : []);

  const close = () => { ui.help = false; };
  // the sheet locks the page scroll: close it first, then scroll
  function jump(id: string) {
    close();
    requestAnimationFrame(() => requestAnimationFrame(() =>
      scrollTarget(document.getElementById(id))?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })));
  }
  async function startTour() {
    close();
    await resetTour();
    navigate('today');
  }
  function toInsights() {
    close();
    navigate('history');
  }
</script>

<Sheet title={t('hlpTitle')} onclose={close} tall>
  <div class="help">
    <section class="entry tour" aria-labelledby="hlp-tour">
      <h3 id="hlp-tour">{t('hlpTourT')}</h3>
      <p>{t('hlpTourText')}</p>
      <button class="btn primary" onclick={startTour}>{t('hlpTourStart')}</button>
    </section>

    <div class="sec-head">
      <h2 class="display">{t('historyTitle')}</h2>
      {#if !onInsights}<button class="chip small" onclick={toInsights}>{t('hlpToInsights')}</button>{/if}
    </div>
    <p class="intro">{onInsights ? t('hlpIntro') : t('hlpIntroElsewhere')}</p>
    <ul class="list">
      {#each INSIGHTS_HELP as e (e.id)}
        <li class="entry">
          <div class="head">
            <h3>{tx(e.title)}</h3>
            {#if e.target && present.has(e.target)}
              <button class="chip small" onclick={() => jump(e.target as string)} aria-label={tx('hlpShowAria', { name: tx(e.title) })}>{t('hlpShow')}</button>
            {/if}
          </div>
          <p>{tx(`hlp_${e.id}`)}</p>
          {#if e.needs}
            <p class="needs">{t('hlpNeeds')}</p>
            <ul class="needlist">{#each e.needs as n}<li>{tx(n)}</li>{/each}</ul>
          {/if}
          {#if onInsights && e.target && !present.has(e.target)}<p class="note">{t('hlpHidden')}</p>{/if}
        </li>
      {/each}
    </ul>
  </div>
</Sheet>

<style>
  .help { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }
  .intro { color: var(--quiet); }
  .list { display: flex; flex-direction: column; gap: 10px; }
  .entry { background: var(--paper); border-radius: 22px 22px 22px 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
  .tour { gap: 8px; }
  .tour .btn { align-self: flex-start; margin-top: 4px; }
  .sec-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; }
  .sec-head h2 { font-size: 24px; line-height: 1.05; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  h3 { font-size: 16px; font-weight: 700; line-height: 1.2; }
  .chip.small { min-height: 36px; padding: 0 14px; font-size: 13px; flex-shrink: 0; }
  p { font-size: 14px; line-height: 1.45; }
  .needs { font-weight: 600; margin-top: 2px; }
  .needlist { list-style: disc; padding-left: 20px; font-size: 14px; line-height: 1.45; }
  .note { font-size: 13px; color: var(--quiet); }
</style>
