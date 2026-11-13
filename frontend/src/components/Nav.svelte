<script lang="ts">
  import { initialOf } from '../lib/account';
  import { t } from '../lib/i18n';
  import { hrefOf, router, type Route } from '../lib/router.svelte';
  import { mealByTime, openAdd, switchDemo, ui } from '../lib/store.svelte';
  import Icon from './Icon.svelte';

  type Item = { route: Route; icon: 'home' | 'bars' | 'list' | 'trend' | 'pot'; label: () => string; tip?: () => string };
  const today: Item = { route: 'today', icon: 'home', label: () => t('navToday') };
  const history: Item = { route: 'history', icon: 'bars', label: () => t('navHistory') };
  const products: Item = { route: 'products', icon: 'list', label: () => t('navProducts'), tip: () => t('navProductsTip') };
  const recipes: Item = { route: 'recipes', icon: 'pot', label: () => t('navRecipes') };
  const weight: Item = { route: 'weight', icon: 'trend', label: () => t('navWeight') };

  // phone: the floating bar holds the four main places, everything else (weight, badges, profile, admin, sign-out) is in the
  // more menu behind the avatar (MoreMenu); wide screens: daily views on top, management (products, recipes, profile) set apart below
  const phone = [today, history, products, recipes];
  const daily = [today, history, weight];

  const wideQuery = window.matchMedia('(min-width: 900px)');
  let wide = $state(wideQuery.matches);
  $effect(() => {
    const on = () => (wide = wideQuery.matches);
    wideQuery.addEventListener('change', on);
    return () => wideQuery.removeEventListener('change', on);
  });

  const initial = $derived(initialOf(ui.me?.display_name || ui.me?.username, ''));
  const profileActive = $derived(router.route === 'profile');
  const adminActive = $derived(router.route === 'admin');
  const isAdmin = $derived(ui.me?.is_admin === true);
  // admins: a small button for the built-in demo account (to it, or back); the phone has it in the more menu
  const canSwitch = $derived(ui.me?.demo_account?.can_switch === true);
  const viewing = $derived(ui.me?.demo_account?.viewing === true);
  const swapLabel = $derived(canSwitch ? t('demoAcctSwitch') : t('demoAcctBackShort'));
  const scan = () => openAdd(mealByTime(), ui.day, 'scan');
</script>

{#snippet link(item: Item)}
  {@const active = router.route === item.route}
  {@const tip = item.tip ? item.tip() : item.label()}
  <a href={hrefOf(item.route)} data-tour="nav-{item.route}" class:active aria-label={tip} title={tip} aria-current={active ? 'page' : undefined}>
    <Icon name={item.icon} />
    {#if active}<span>{item.label()}</span>{/if}
  </a>
{/snippet}

{#snippet scanButton()}
  <button class="scan" data-tour="scan" class:pulse={ui.pulse % 2 === 1} class:pulse2={ui.pulse > 0 && ui.pulse % 2 === 0}
    aria-label={t('navScan')} title={t('navScan')} onclick={scan}>
    <svg class="dots" width="60" height="60" viewBox="0 0 60 60" aria-hidden="true">
      <circle cx="30" cy="30" r="26" fill="none" stroke="#17211c" stroke-width="3" stroke-dasharray="2 4.806" />
    </svg>
    <Icon name="scan" size={24} stroke={2.4} />
  </button>
{/snippet}

<nav aria-label="Navigation" class:wide>
  {#if wide}
    <div class="group">
      {#each daily as item}{@render link(item)}{/each}
    </div>
    <div class="group manage" role="group" aria-label={t('navManage')}>
      {@render link(products)}
      {@render link(recipes)}
      {#if canSwitch || viewing}
        <button type="button" class="swap" aria-label={swapLabel} title={swapLabel} onclick={() => switchDemo(canSwitch)}><Icon name="repeat" /></button>
      {/if}
      {#if isAdmin}
        <a href={hrefOf('admin')} class:active={adminActive} aria-label={t('navAdmin')} title={t('navAdmin')} aria-current={adminActive ? 'page' : undefined}>
          <Icon name="shield" />
        </a>
      {/if}
      <a href={hrefOf('profile')} class="me" data-tour="nav-profile" class:active={profileActive} aria-label={t('navProfile')} title={t('navProfile')}
        aria-current={profileActive ? 'page' : undefined}>
        {#if initial}<span class="display">{initial}</span>{:else}<Icon name="user" />{/if}
      </a>
    </div>
    {@render scanButton()}
  {:else}
    {#each phone as item}{@render link(item)}{/each}
    {@render scanButton()}
  {/if}
</nav>

<style>
  nav {
    position: fixed; z-index: 20; left: 50%; transform: translateX(-50%); bottom: calc(18px + var(--safe-b));
    width: min(358px, calc(100% - 32px)); height: var(--nav-h); border-radius: 36px; padding: 0 8px 0 10px;
    background: var(--deep); display: flex; align-items: center; justify-content: space-between; --focus: var(--lime);
  }
  a, .swap {
    height: 48px; min-width: 48px; border-radius: 24px; color: var(--on-deep); display: flex; align-items: center; justify-content: center;
    gap: 8px; text-decoration: none; font-size: 14px; font-weight: 600;
  }
  a :global(svg) { flex-shrink: 0; }
  .swap { background: transparent; }
  a.active { background: var(--nav-on-bg); color: var(--nav-on-fg); padding: 0 16px; }
  .scan {
    position: relative; width: 60px; height: 60px; border-radius: 30px; background: var(--lime); color: var(--on-lime);
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .dots { position: absolute; inset: 0; }
  .pulse { animation: pulse 520ms ease-out; }
  .pulse2 { animation: pulse2 520ms ease-out; }
  @keyframes pulse { 0% { transform: scale(1); } 35% { transform: scale(1.22); } 100% { transform: scale(1); } }
  @keyframes pulse2 { 0% { transform: scale(1); } 35% { transform: scale(1.22); } 100% { transform: scale(1); } }
  .group { display: contents; }
  /* wide screens: the bar becomes a slim rail on the left edge, same shapes and colours */
  @media (min-width: 900px) {
    nav {
      left: 16px; top: calc(16px + var(--band, 0px)); bottom: 16px; transform: none; width: 76px; height: auto; border-radius: 38px;
      padding: 18px 8px 8px; flex-direction: column; justify-content: flex-start; gap: 10px;
    }
    .group { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    /* the second group sinks to the bottom, above the scan button, behind a fine divider */
    .manage { margin-top: auto; padding-top: 12px; position: relative; }
    .manage::before { content: ''; position: absolute; top: 0; left: 14px; right: 14px; height: 2px; border-radius: 1px; background: var(--deep-line); }
    a, a.active, .swap { width: 52px; height: 52px; padding: 0; border-radius: 26px; }
    .swap:hover, a:hover:not(.active) { background: rgba(247, 248, 245, 0.14); }
    a:not(.me) span { display: none; }
    .me { font-size: 18px; border: 2px solid var(--deep-line); }
    .me .display { letter-spacing: 0; font-family: var(--f-display); font-weight: 800; line-height: 1; }
    .me.active { border-color: var(--nav-on-bg); }
    .scan { margin-top: 6px; }
  }
</style>
