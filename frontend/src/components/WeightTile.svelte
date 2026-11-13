<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { api } from '../lib/api';
  import { daysBetween, shortDate } from '../lib/date';
  import { fmt1, t } from '../lib/i18n';
  import { hrefOf } from '../lib/router.svelte';
  import { ui } from '../lib/store.svelte';
  import type { WeightPoint } from '../lib/types';

  // A quiet line on the day view: the latest weight and how it moved over the last week, a tap opens the weight page.
  // Weight mostly arrives by itself (automations, the API), so this is a display first; without any value it is a gentle invitation.
  let points = $state<WeightPoint[] | null>(null);
  let seq = 0;

  async function load() {
    const mine = ++seq;
    try {
      const list = await api.weights(30);
      if (mine === seq) points = list;
    } catch { if (mine === seq && points === null) points = []; /* a bonus tile: stay silent when it cannot load */ }
  }
  $effect(() => { ui.version; untrack(() => { void load(); }); });

  const latest = $derived(points && points.length ? points[points.length - 1] : null);
  // the entry closest to a week before the latest one (4 to 10 days back), else no change is shown
  const week = $derived.by(() => {
    if (!latest || !points) return null;
    let best: WeightPoint | null = null;
    for (const p of points) {
      const back = daysBetween(p.day, latest.day);
      if (back < 4 || back > 10) continue;
      if (!best || Math.abs(back - 7) < Math.abs(daysBetween(best.day, latest.day) - 7)) best = p;
    }
    return best ? Math.round((latest.kg - best.kg) * 10) / 10 : null;
  });
  const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt1(Math.abs(v))}`;
  const arrow = (v: number) => (v > 0 ? '↑' : v < 0 ? '↓' : '=');
  const when = $derived(!latest ? '' : latest.day === ui.today ? t('weightToday') : t('wtOn', { date: shortDate(latest.day) }));
  // one line: when the value is from, and how it moved over the week (arrow and words, no verdict)
  const line = $derived(week == null ? when : `${when} · ${arrow(week)} ${t('wtChange7', { d: signed(week) })}`);
</script>

{#if points && latest}
  <a class="wt" href={hrefOf('weight')} aria-label={t('wtTileOpen', { kg: fmt1(latest.kg), when: line })}>
    <span class="ic" aria-hidden="true"><Icon name="trend" size={20} stroke={2.4} /></span>
    <span class="t">
      <span class="micro lab">{t('wtTileTitle')}</span>
      <span class="when">{line}</span>
    </span>
    <span class="val display" aria-hidden="true">{fmt1(latest.kg)}<small class="mono"> {t('kg')}</small></span>
  </a>
{:else if points}
  <a class="wt invite" href={hrefOf('weight')} aria-label={t('wtInviteAria')}>
    <span class="ic" aria-hidden="true"><Icon name="trend" size={20} stroke={2.4} /></span>
    <span class="t"><span class="micro lab">{t('wtInviteTitle')}</span><span class="when">{t('wtInviteText')}</span></span>
    <Icon name="right" size={18} />
  </a>
{/if}

<style>
  .wt {
    display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 8px 18px 8px 12px; background: var(--paper); color: var(--text);
    border-radius: 28px 28px 28px 8px; text-decoration: none; min-width: 0;
  }
  .ic { width: 40px; height: 40px; border-radius: 16px 16px 16px 6px; background: var(--stone); color: var(--green-text); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .t { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .lab { color: var(--quiet); }
  .when { font-size: 13px; color: var(--quiet); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .val { font-size: 28px; line-height: 1; letter-spacing: -0.03em; white-space: nowrap; }
  .val small { font-size: 12px; letter-spacing: 0; font-weight: 500; }
  .invite { background: transparent; box-shadow: inset 0 0 0 2px var(--hairline); color: var(--quiet); }
  .invite .when { white-space: normal; }
  @media (min-width: 900px) { .wt { min-height: 72px; padding-left: 16px; padding-right: 24px; } .val { font-size: 34px; } }
</style>
