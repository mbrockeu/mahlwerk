<script lang="ts">
  import { t } from '../lib/i18n';
  import type { Food } from '../lib/types';
  import FoodSearch from './FoodSearch.svelte';
  import ScanPane from './ScanPane.svelte';
  import Sheet from './Sheet.svelte';

  // The same search and scan as in the add sheet, but the pick goes back to the recipe instead of the diary.
  let { onpick, onclose }: { onpick: (food: Food) => void; onclose: () => void } = $props();

  let tab = $state<'search' | 'scan'>('search');
  const tabs = [{ id: 'search', label: () => t('tabSearch') }, { id: 'scan', label: () => t('tabScan') }] as const;

  function tabKey(event: KeyboardEvent, i: number) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const next = tabs[(i + 1) % tabs.length].id;
    tab = next;
    (document.getElementById(`itab-${next}`) as HTMLElement | null)?.focus();
  }
</script>

<Sheet title={t('ingredientTitle')} {onclose} tall>
  <div class="tabs" role="tablist">
    {#each tabs as item, i}
      <button role="tab" id="itab-{item.id}" aria-selected={tab === item.id} aria-controls="ipanel" tabindex={tab === item.id ? 0 : -1}
        class:on={tab === item.id} onclick={() => (tab = item.id)} onkeydown={(e) => tabKey(e, i)}>{item.label()}</button>
    {/each}
  </div>
  <div role="tabpanel" id="ipanel" aria-labelledby="itab-{tab}" class="panel">
    {#if tab === 'scan'}
      <ScanPane meal="lunch" day="" onfood={onpick} />
    {/if}
    <div hidden={tab !== 'search'}><FoodSearch {onpick} active={tab === 'search'} /></div>
  </div>
</Sheet>

<style>
  .tabs { display: flex; background: var(--paper); border-radius: 26px; padding: 4px; gap: 4px; flex-shrink: 0; }
  .tabs button { flex: 1; min-height: 44px; border-radius: 22px; font-weight: 600; font-size: 14px; color: var(--quiet); }
  .tabs button.on { background: var(--sel-bg); color: var(--sel-fg); }
  .panel { display: flex; flex-direction: column; gap: 12px; }
  [hidden] { display: none; }
</style>
