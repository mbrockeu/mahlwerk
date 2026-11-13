<script lang="ts">
  // A button that opens a small floating menu of actions (same pattern as the more menu): opening moves focus to the first entry, Up/Down/Home/End
  // move, Esc and a click outside close (Esc returns focus to the button), Tab leaves the menu.
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';

  type Item = { key: string; label: string; icon?: 'plus' | 'pot' | 'search' | 'down' | 'repeat' | 'bookmark'; onselect: () => void };
  let { items, label = '', aria, icon, tone = 'plain', testid }: { items: Item[]; label?: string; aria: string; icon?: 'plus' | 'down'; tone?: 'lime' | 'plain'; testid?: string } = $props();

  let open = $state(false);
  let root: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  let menu: HTMLDivElement | undefined = $state();
  const id = `am-${Math.random().toString(36).slice(2, 8)}`;
  const entries = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  async function show(last = false) {
    open = true;
    await tick();
    const list = entries();
    (last ? list[list.length - 1] : list[0])?.focus();
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
    const list = entries();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close(false);
  }
  const outside = (e: PointerEvent) => { if (open && root && !root.contains(e.target as Node)) close(false); };
  const choose = (item: Item) => { open = false; item.onselect(); };
</script>

<svelte:window onpointerdown={outside} />

<div class="am" bind:this={root}>
  <button type="button" class="btn {tone === 'lime' ? 'lime' : ''} trig" class:iconly={!label} bind:this={trigger} aria-haspopup="menu" aria-expanded={open} aria-controls={id} aria-label={aria}
    data-testid={testid} onclick={toggle} onkeydown={triggerKey}>
    {#if icon === 'plus'}<Icon name="plus" size={20} stroke={2.6} />{/if}
    {#if label}<span>{label}</span>{/if}
    {#if icon === 'down' || (!icon && label)}<span class="chev" class:up={open} aria-hidden="true"><Icon name="down" size={18} stroke={2.4} /></span>{/if}
  </button>
  {#if open}
    <div class="menu" {id} role="menu" aria-label={aria} tabindex="-1" bind:this={menu} onkeydown={menuKey}>
      {#each items as item (item.key)}
        <button type="button" role="menuitem" data-testid={`menu-${item.key}`} onclick={() => choose(item)}>
          {#if item.icon}<Icon name={item.icon} size={22} />{/if}<span>{item.label}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .am { position: relative; --focus: var(--focus-base); }
  .trig { min-height: 44px; padding: 0 16px; }
  .trig.iconly { width: 44px; padding: 0; border-radius: 22px 22px 22px 8px; }
  .chev { display: inline-flex; transition: transform 160ms; }
  .chev.up { transform: rotate(180deg); }
  .menu {
    position: absolute; z-index: 25; top: calc(100% + 8px); right: 0; min-width: 240px; max-width: calc(100vw - 32px); padding: 8px; border-radius: 28px 8px 28px 28px;
    background: var(--deep); color: var(--on-deep); display: flex; flex-direction: column; gap: 2px; --focus: var(--lime); outline: none;
    box-shadow: 0 18px 44px rgba(23, 33, 28, 0.32), 0 0 0 1px var(--deep-edge); transform-origin: calc(100% - 22px) -6px; animation: unfold 170ms cubic-bezier(0.2, 0.9, 0.25, 1);
  }
  .menu button { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 0 16px 0 14px; border-radius: 20px; width: 100%; color: inherit; font-size: 15px; font-weight: 600; text-align: left; white-space: nowrap; }
  .menu button:hover { background: rgba(247, 248, 245, 0.12); }
  @keyframes unfold { from { opacity: 0; transform: scale(0.88) translateY(-6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .menu { animation: none; } .chev { transition: none; } }
</style>
