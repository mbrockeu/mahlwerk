<script lang="ts">
  import { onMount } from 'svelte';
  import BadgeMark from '../components/BadgeMark.svelte';
  import Icon from '../components/Icon.svelte';
  import TickBar from '../components/TickBar.svelte';
  import { api, ApiError } from '../lib/api';
  import { fmtDate, t } from '../lib/i18n';
  import { navigate } from '../lib/router.svelte';
  import { ui } from '../lib/store.svelte';
  import type { BadgeCode, Badges } from '../lib/types';

  let data = $state<Badges | null>(null);
  let error = $state('');
  let fresh = $state<Set<string>>(new Set());
  let picked = $state<BadgeCode | null>(null);
  const playful = $derived(ui.me?.settings?.playful !== false);

  onMount(async () => {
    try {
      const r = await api.badges();
      data = r;
      fresh = new Set(r.new);
      if (r.new.length) void api.badgesSeen(r.new).catch(() => {}); // looking at the wall counts as seeing them
    } catch (err) {
      error = err instanceof ApiError ? String(err.status || err.message) : 'error';
    }
  });

  const earned = $derived([...(data?.earned ?? [])].sort((a, b) => b.earned_at - a.earned_at));
  const open = $derived(data?.open ?? []);
  const total = $derived(earned.length + open.length);
  const current = $derived<BadgeCode | null>(picked ?? earned[0]?.code ?? open[0]?.code ?? null);
  const info = $derived.by(() => {
    if (!current) return null;
    const e = earned.find((b) => b.code === current);
    const o = open.find((b) => b.code === current);
    return { code: current, earned: e ?? null, open: o ?? null };
  });
  const progressText = (code: BadgeCode, p: { current: number; target: number }) => t(`badgeProg_${code}`, p);
  const label = (code: BadgeCode, p?: { current: number; target: number }) =>
    p ? t('badgeAriaOpen', { name: t(`badge_${code}`), progress: progressText(code, p) }) : t('badgeAriaEarned', { name: t(`badge_${code}`) });
</script>

<div class="page">
  <div class="page-head">
    <h1>{t('badgesTitle')}</h1>
    <button class="round" onclick={() => navigate('today')} aria-label={t('back')}><Icon name="close" size={22} /></button>
  </div>

  {#if !playful}
    <p class="note">{t('badgesOff')} <a href="#/profile">{t('profile')}</a></p>
  {:else if error && !data}
    <div class="error-box"><p>{t('loadFailed', { reason: error })}</p></div>
  {:else if !data}
    <div class="skel" aria-hidden="true"></div>
  {:else}
    <section class="hero on-dark" aria-label={t('badgesAria', { n: earned.length, total })}>
      <span class="micro lab">{t('badgesEarned')}</span>
      <span class="big">{earned.length}<small> / {total}</small></span>
      <svg viewBox="0 0 {total * 6 - 3} 20" preserveAspectRatio="none" width="100%" height="22" aria-hidden="true">
        {#each { length: total } as _, i}<rect x={i * 6} y={i < earned.length ? 0 : 7} width="3" height={i < earned.length ? 20 : 13} rx="1.5" fill={i < earned.length ? '#c9f04a' : '#4d8a70'} />{/each}
      </svg>
    </section>

    {#if info}
      <section class="detail" aria-live="polite">
        <BadgeMark code={info.code} earned={!!info.earned} progress={info.open?.progress ?? null} size={84} />
        <div class="txt">
          <h2 class="display">{t(`badge_${info.code}`)}</h2>
          <p>{t(`badgeCond_${info.code}`)}</p>
          {#if info.earned}
            <p class="mono stat">{t('badgeEarnedOn', { date: fmtDate(info.earned.earned_at) })}</p>
          {:else if info.open}
            <p class="mono stat">{progressText(info.code, info.open.progress)}</p>
            {#if info.open.progress.target > 1}
              <TickBar value={info.open.progress.current} goal={info.open.progress.target} track="var(--track)" fill="var(--bar)" label="" height={10} />
            {/if}
          {/if}
        </div>
      </section>
    {/if}

    {#if earned.length === 0}<p class="note">{t('badgesNone')}</p>{/if}

    {#if earned.length}
      <h2 class="micro quiet group">{t('badgesEarned')}</h2>
      <ul class="grid">
        {#each earned as b (b.code)}
          <li>
            <button class="cell" class:on={current === b.code} aria-pressed={current === b.code} onclick={() => (picked = b.code)} aria-label={label(b.code)}>
              <BadgeMark code={b.code} size={72} />
              <span class="nm">{t(`badge_${b.code}`)}</span>
              {#if fresh.has(b.code)}<span class="badge">{t('badgeNew')}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if open.length}
      <h2 class="micro quiet group">{t('badgesOpen')}</h2>
      <ul class="grid">
        {#each open as b (b.code)}
          <li>
            <button class="cell" class:on={current === b.code} aria-pressed={current === b.code} onclick={() => (picked = b.code)} aria-label={label(b.code, b.progress)}>
              <BadgeMark code={b.code} earned={false} progress={b.progress} size={72} />
              <span class="nm">{t(`badge_${b.code}`)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .skel { height: 220px; border-radius: 44px 44px 44px 14px; background: var(--hairline); opacity: 0.5; }
  .hero { background: var(--green); color: #fff; border-radius: 44px 44px 44px 14px; padding: 20px 24px 22px; display: flex; flex-direction: column; gap: 6px; --focus: var(--lime); }
  .lab { color: #d5ead0; }
  .big { font-family: var(--f-display); font-weight: 800; font-size: 52px; letter-spacing: -0.04em; line-height: 1; }
  .big small { font-family: var(--f-mono); font-size: 16px; font-weight: 500; letter-spacing: 0; margin-left: 4px; }
  .hero svg { margin-top: 8px; display: block; }
  .detail { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 18px; display: flex; gap: 16px; align-items: center; }
  .txt { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
  .txt h2 { font-size: 24px; line-height: 1.05; }
  .txt p { font-size: 14px; color: var(--quiet); }
  .txt .stat { font-size: 13px; color: var(--text); font-weight: 600; margin-top: 2px; }
  .group { margin-top: 10px; }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .cell { position: relative; width: 100%; min-height: 120px; padding: 12px 4px 8px; border-radius: 20px; background: transparent; display: flex; flex-direction: column; align-items: center; gap: 6px; border: 2px solid transparent; }
  .cell.on { background: var(--paper); border-color: var(--text); }
  .nm { font-size: 12.5px; font-weight: 600; line-height: 1.15; text-align: center; max-width: 11ch; }
  .cell .badge { position: absolute; top: 6px; right: 6px; }
  @media (min-width: 900px) { .grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
</style>
