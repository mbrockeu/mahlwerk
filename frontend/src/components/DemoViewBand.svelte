<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n';
  import { switchDemo, ui } from '../lib/store.svelte';

  // The band that stays on screen while an admin looks at the built-in demo account: what this is, and the way back. A calm band in the
  // style of the public demo's, it takes its height from `--band` (set on <html>) so that the fixed rail and the sticky bars sit below it.
  const name = $derived(ui.me?.demo_account?.real_display_name || ui.me?.demo_account?.real_username || '');
  let busy = $state(false);
  onMount(() => {
    document.documentElement.classList.add('demoview');
    return () => document.documentElement.classList.remove('demoview');
  });
  async function back() {
    busy = true;
    await switchDemo(false);
    busy = false;
  }
</script>

<div class="band" role="status">
  <span class="msg">{t('demoAcctBand')}</span>
  <button type="button" class="back" disabled={busy} onclick={back}>{name ? t('demoAcctBack', { name }) : t('demoAcctBackShort')}</button>
</div>

<style>
  :global(html.demoview) { --band: calc(38px + var(--safe-t)); }
  :global(html.demoview #app) { padding-top: var(--band); }
  .band {
    position: fixed; z-index: 60; top: 0; left: 0; right: 0; height: var(--band); padding: var(--safe-t) 12px 0; box-sizing: border-box;
    display: flex; align-items: center; justify-content: center; gap: 12px;
    background: var(--lime); color: #17211c; font: 600 12.5px/1.2 var(--f-body);
  }
  .msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .back {
    flex: none; min-height: 28px; padding: 0 12px; border-radius: 14px 14px 14px 5px; background: #17211c; color: #f7f8f5; font: inherit; font-weight: 700;
    white-space: nowrap;
  }
  .back:disabled { opacity: 0.6; }
  .back:focus-visible { outline: 3px solid #17211c; outline-offset: 2px; }
  @media (max-width: 560px) {
    .band { justify-content: space-between; }
    .msg { white-space: normal; font-size: 11.5px; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  }
</style>
