<script lang="ts">
  import { tick } from 'svelte';
  import { initialOf } from '../lib/account';
  import { t } from '../lib/i18n';
  import { hrefOf, router, type Route } from '../lib/router.svelte';
  import { auth, signOut, switchDemo, ui } from '../lib/store.svelte';
  import Icon from './Icon.svelte';

  // The phone's "more" menu: the round avatar at the top right opens a small floating sheet with everything that is not in
  // the bottom bar (weight, badges, profile and goals, admin, sign-out). From 900 px the rail has all of it, the avatar is hidden.
  // The avatar is placed by App on every main page; it scrolls away with the page like a title does.
  type Entry = { route: Route; icon: 'trend' | 'medal' | 'user' | 'shield'; label: string };

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let menu: HTMLDivElement | undefined = $state();

  const initial = $derived(initialOf(ui.me?.display_name || ui.me?.username, '?'));
  const playful = $derived(ui.me?.settings?.playful !== false);
  const entries = $derived<Entry[]>([
    { route: 'weight', icon: 'trend', label: t('navWeight') },
    ...(playful ? [{ route: 'badges' as Route, icon: 'medal' as const, label: t('badgesTitle') }] : []),
    { route: 'profile', icon: 'user', label: t('profile') },
    ...(ui.me?.is_admin === true ? [{ route: 'admin' as Route, icon: 'shield' as const, label: t('navAdmin') }] : []),
  ]);
  const withSignOut = $derived(auth.mode === 'local' || auth.mode === 'oidc');
  // the avatar shows that one of the menu's pages is open (weight is the one main page that lives in the menu)
  const here = $derived(router.route === 'weight');

  const items = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  async function show(focusLast = false) {
    open = true;
    await tick();
    const list = items();
    (focusLast ? list[list.length - 1] : list[0])?.focus();
  }
  function close(focusTrigger = true) {
    if (!open) return;
    open = false;
    if (focusTrigger) trigger?.focus();
  }
  const toggle = () => { if (open) close(false); else void show(); };

  function triggerKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); void show(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); void show(true); }
  }
  function menuKey(e: KeyboardEvent) {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  }
  function outside(e: PointerEvent) {
    if (open && root && !root.contains(e.target as Node)) close(false);
  }
  // leaving the page or a dialog opening ends the menu
  $effect(() => { void router.route; open = false; });
  $effect(() => { if (ui.add || ui.amount || ui.recipe || ui.editor || ui.workout || ui.moment) open = false; });
  const leave = async () => { open = false; await signOut(); };
  // admins can switch to the built-in demo account (and back) from here
  const canSwitch = $derived(ui.me?.demo_account?.can_switch === true);
  const viewing = $derived(ui.me?.demo_account?.viewing === true);
  const swap = async (toDemo: boolean) => { open = false; await switchDemo(toDemo); };
</script>

<svelte:window onpointerdown={outside} />

<div class="more" data-menu>
  <div class="anchor" bind:this={root}>
    <button class="round avatar" class:here bind:this={trigger} data-tour="avatar" aria-haspopup="menu" aria-expanded={open}
      aria-controls="more-menu" aria-label={t('menuOpen')} title={t('menuOpen')} onclick={toggle} onkeydown={triggerKey}>
      {#if ui.me}<span class="display">{initial}</span>{:else}<Icon name="user" />{/if}
    </button>
    {#if open}
      <div class="menu" id="more-menu" role="menu" aria-label={t('menuTitle')} tabindex="-1" bind:this={menu} onkeydown={menuKey}>
        {#each entries as e (e.route)}
          <a role="menuitem" href={hrefOf(e.route)} class:active={router.route === e.route} aria-current={router.route === e.route ? 'page' : undefined}
            onclick={() => (open = false)}>
            <Icon name={e.icon} size={22} /><span>{e.label}</span>
          </a>
        {/each}
        {#if canSwitch || viewing}
          <span class="sep" role="separator"></span>
          <button type="button" role="menuitem" onclick={() => swap(canSwitch)}><Icon name="repeat" size={22} />
            <span>{canSwitch ? t('demoAcctSwitch') : t('demoAcctBackShort')}</span></button>
        {/if}
        {#if withSignOut}
          <span class="sep" role="separator"></span>
          <button type="button" role="menuitem" onclick={leave}><Icon name="logout" size={22} /><span>{t('acctSignOut')}</span></button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* a zero-height strip with the page's frame (480 px, 20 px gutter) so that the avatar sits where the title row ends */
  .more { position: absolute; z-index: 25; top: var(--band, 0px); left: 0; right: 0; max-width: 480px; margin: 0 auto; height: 0; pointer-events: none; }
  .anchor { position: absolute; top: calc(26px + var(--safe-t)); right: 20px; pointer-events: auto; --focus: var(--focus-base); }
  .avatar { background: var(--deep); color: var(--on-deep); font-size: 18px; box-shadow: 0 0 0 0 var(--lime); transition: box-shadow 160ms; }
  .avatar .display { letter-spacing: 0; }
  .avatar[aria-expanded='true'] { background: var(--nav-on-bg); color: var(--nav-on-fg); }
  .avatar.here { box-shadow: 0 0 0 3px var(--bar); }
  .menu {
    position: absolute; top: 54px; right: 0; width: 236px; padding: 8px; border-radius: 28px 8px 28px 28px; background: var(--deep); color: var(--on-deep);
    display: flex; flex-direction: column; gap: 2px; --focus: var(--lime); outline: none;
    box-shadow: 0 18px 44px rgba(23, 33, 28, 0.32), 0 0 0 1px var(--deep-edge); transform-origin: calc(100% - 22px) -6px;
    animation: unfold 170ms cubic-bezier(0.2, 0.9, 0.25, 1);
  }
  .menu a, .menu button {
    display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 0 16px 0 14px; border-radius: 20px; width: 100%;
    color: inherit; text-decoration: none; font-size: 15px; font-weight: 600; text-align: left;
  }
  .menu a:hover, .menu button:hover { background: rgba(247, 248, 245, 0.12); }
  .menu a.active { background: var(--nav-on-bg); color: var(--nav-on-fg); }
  .sep { display: block; height: 2px; margin: 4px 14px; border-radius: 1px; background: var(--deep-line); }
  @keyframes unfold { from { opacity: 0; transform: scale(0.86) translateY(-6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .menu { animation: none; } .avatar { transition: none; } }
  @media (min-width: 900px) { .more { display: none; } }
</style>
