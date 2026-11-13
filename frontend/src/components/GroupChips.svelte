<script lang="ts">
  // The filter row above the recipe list: "All", one chip per group with its count, "No group", and the way to the group manager.
  // It scrolls sideways on a narrow screen (the chips are buttons, so the keyboard reaches all of them; the active one is scrolled into view).
  import { fmt, t } from '../lib/i18n';
  import Icon from './Icon.svelte';

  interface Chip { value: string; label: string; n: number; auto?: boolean }
  let { chips, active, onpick, onmanage }: { chips: Chip[]; active: string; onpick: (value: string) => void; onmanage: () => void } = $props();
  let row: HTMLDivElement;

  $effect(() => {
    active;
    // scroll the row itself, never the page (scrollIntoView would also move the page when something sits above the chips)
    const on = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (row && on) row.scrollTo({ left: on.offsetLeft - (row.clientWidth - on.offsetWidth) / 2, behavior: 'auto' });
  });
</script>

<div class="wrap">
  <div class="chips" role="group" aria-label={t('grpAria')} bind:this={row}>
    {#each chips as c (c.value)}
      <button type="button" class="chip" class:on={active === c.value} aria-pressed={active === c.value} aria-label={t('grpChipAria', { name: c.label, n: c.n })} onclick={() => onpick(c.value)}>
        <span class="lab">{c.label}</span><span class="n mono">{fmt(c.n)}</span>
      </button>
    {/each}
  </div>
  <button type="button" class="round manage" onclick={onmanage} aria-label={t('grpManage')} title={t('grpManage')}><Icon name="folder" size={20} /></button>
</div>

<style>
  .wrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .chips { position: relative; display: flex; gap: 8px; overflow-x: auto; padding: 4px 2px; flex: 1; min-width: 0; scrollbar-width: none; overscroll-behavior-x: contain; }
  .chips::-webkit-scrollbar { display: none; }
  .chip { flex-shrink: 0; gap: 8px; max-width: 240px; }
  .lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .n { font-size: 12px; font-weight: 600; opacity: 0.8; }
  .manage { border: 2px solid var(--hairline); }
</style>
