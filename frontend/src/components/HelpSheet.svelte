<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../lib/i18n';
  import { INSIGHT_TABS, INSIGHTS_HELP, parseTab, scrollTarget, type HelpEntry, type InsightTab } from '../lib/help';
  import { reducedMotion } from '../lib/motion.svelte';
  import { navigate, router, setQuery } from '../lib/router.svelte';
  import { resetTour, ui } from '../lib/store.svelte';
  import Sheet from './Sheet.svelte';

  // The help (menu, rail, evaluation page): the tour of the day view, then every card of the evaluation – what it shows,
  // what it needs, and on the evaluation page a jump to it. Cards not on the page right now (nothing logged in the period)
  // are still explained, with a note instead of the jump. Elsewhere one button leads to the evaluation.
  const tx = (key: string, p?: Record<string, string>) => t(key as 'hlpOpen', p);
  const onInsights = router.route === 'history';
  // read once when the sheet opens (the page behind does not change while it is open): which tab is open, whether the
  // period has entries, which targets are on the page. A card of another tab can be shown when the period has entries.
  const current = parseTab(router.query.get('tab'));
  const logged = onInsights && document.querySelector('[data-logged="1"]') != null;
  const here = new Set(onInsights ? INSIGHTS_HELP.filter((e) => e.target && document.getElementById(e.target)).map((e) => e.target as string) : []);
  const canShow = (e: HelpEntry) => onInsights && !!e.target && (here.has(e.target) || (logged && e.tab !== current));
  const TAB_LABEL = { overview: 'tabOverview', food: 'tabFood', body: 'tabBody', nutrients: 'tabNutrients', foods: 'tabFoods' } as const;
  const groups: { tab: InsightTab | null; entries: HelpEntry[] }[] = [
    { tab: null, entries: INSIGHTS_HELP.filter((e) => e.tab == null) },
    ...INSIGHT_TABS.map((tb) => ({ tab: tb, entries: INSIGHTS_HELP.filter((e) => e.tab === tb) })),
  ];

  const close = () => { ui.help = false; };
  // the sheet locks the page scroll: close it first, then scroll
  async function jump(e: HelpEntry) {
    close();
    if (e.tab && e.tab !== current) {
      const params = Object.fromEntries(router.query.entries());
      if (e.tab === 'overview') delete params.tab; else params.tab = e.tab;
      setQuery(params);
      await tick();
    }
    requestAnimationFrame(() => requestAnimationFrame(() =>
      scrollTarget(document.getElementById(e.target as string))?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' })));
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
    {#each groups as gr (gr.tab ?? 'all')}
    {#if gr.tab}<h3 class="group">{t(TAB_LABEL[gr.tab])}</h3>{/if}
    <ul class="list">
      {#each gr.entries as e (e.id)}
        <li class="entry">
          <div class="head">
            <h3>{tx(e.title)}</h3>
            {#if canShow(e)}
              <button class="chip small" onclick={() => jump(e)} aria-label={tx('hlpShowAria', { name: tx(e.title) })}>{t('hlpShow')}</button>
            {/if}
          </div>
          <p>{tx(`hlp_${e.id}`)}</p>
          {#if e.needs}
            <p class="needs">{t('hlpNeeds')}</p>
            <ul class="needlist">{#each e.needs as n}<li>{tx(n)}</li>{/each}</ul>
          {/if}
          {#if onInsights && e.target && !canShow(e)}<p class="note">{t('hlpHidden')}</p>{/if}
        </li>
      {/each}
    </ul>
    {/each}
  </div>
</Sheet>

<style>
  .help { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }
  .intro { color: var(--quiet); }
  .group { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--quiet); margin: 6px 0 -4px; }
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
