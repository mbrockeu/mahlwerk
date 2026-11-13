<script lang="ts">
  // A small list of text values (countries, hosts): chips with a remove button and a field to add one.
  import { t } from '../lib/i18n';
  let { label, hint, items, disabled = false, placeholder = '', onchange }: {
    label: string; hint?: string; items: string[]; disabled?: boolean; placeholder?: string; onchange: (next: string[]) => void | Promise<void>;
  } = $props();
  let draft = $state('');
  let bad = $state(false);
  const id = `tag-${Math.random().toString(36).slice(2, 8)}`;

  function add() {
    const v = draft.trim().toLowerCase();
    if (!v) return;
    if (!/^[a-z0-9][a-z0-9.:-]{0,100}$/.test(v)) { bad = true; return; }
    bad = false;
    draft = '';
    if (!items.includes(v)) void onchange([...items, v]);
  }
  const remove = (v: string) => void onchange(items.filter((x) => x !== v));
</script>

<div class="tags">
  <label class="lab" for={id}>{label}</label>
  {#if items.length}
    <ul class="chips" aria-label={label}>
      {#each items as v (v)}
        <li>
          <span class="mono">{v}</span>
          <button type="button" {disabled} aria-label={t('admRemoveItem', { name: v })} onclick={() => remove(v)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="add">
    <input {id} type="text" inputmode="url" autocapitalize="none" autocomplete="off" spellcheck="false" {placeholder} {disabled}
      bind:value={draft} aria-invalid={bad} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
    <button type="button" class="btn" {disabled} onclick={add}>{t('admAdd')}</button>
  </div>
  {#if bad}<p class="note warn" role="alert">{t('admListBad')}</p>{:else if hint}<p class="note">{hint}</p>{/if}
</div>

<style>
  .tags { display: flex; flex-direction: column; gap: 8px; }
  .lab { font-size: 13px; font-weight: 600; color: var(--quiet); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  li { display: inline-flex; align-items: center; min-height: 44px; padding: 0 4px 0 14px; border-radius: 22px 22px 22px 8px; background: var(--sel-bg); color: var(--sel-fg); font-size: 13.5px; gap: 2px; }
  li button { width: 44px; height: 44px; border-radius: 22px; display: inline-flex; align-items: center; justify-content: center; color: inherit; --focus: var(--lime); }
  li button:focus-visible { outline-color: var(--lime); outline-offset: -4px; }
  .add { display: flex; gap: 8px; }
  .add input { flex: 1; min-width: 0; min-height: 48px; padding: 0 16px; border-radius: 16px; background: var(--stone); border: 2px solid var(--field-line); font-size: 16px; font-family: var(--f-mono); }
  .add input:focus-visible { outline-offset: 0; border-color: var(--focus-base); }
  .add input[aria-invalid='true'] { border-color: var(--warn); }
  .add .btn { min-height: 48px; }
</style>
