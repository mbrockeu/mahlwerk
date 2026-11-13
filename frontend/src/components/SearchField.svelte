<script lang="ts">
  import { t } from '../lib/i18n';
  import Icon from './Icon.svelte';

  // A search input with our own clear button (the browser's "x" is hidden in app.css). The button shows only while there is text.
  let { value = $bindable(''), oninput, placeholder }: { value: string; oninput?: () => void; placeholder?: string } = $props();
  let input: HTMLInputElement;

  function clear() {
    value = '';
    oninput?.();
    input.focus();
  }
</script>

<div class="searchbox">
  <label class="field">
    <span class="sr-only">{placeholder ?? t('searchPlaceholder')}</span>
    <input bind:this={input} type="search" autocomplete="off" placeholder={placeholder ?? t('searchPlaceholder')} bind:value {oninput} />
  </label>
  {#if value}
    <button type="button" class="clear" onclick={clear} aria-label={t('clearSearch')}><Icon name="close" size={16} stroke={2.4} /></button>
  {/if}
</div>

<style>
  .searchbox { position: relative; }
  .searchbox :global(input) { padding-right: 52px; }
  .clear {
    position: absolute; top: 2px; right: 2px; width: 44px; height: 44px; border-radius: 22px; color: var(--quiet);
    display: flex; align-items: center; justify-content: center;
  }
  .clear:hover { color: var(--text); }
</style>
