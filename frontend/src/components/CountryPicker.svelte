<script lang="ts">
  // The countries of the product catalogue: chips with the country names, a choice to add one, and "other country" for a tag that is not listed.
  import { lang, t } from '../lib/i18n';
  import { countryName, countryOptions } from '../lib/offCountries';
  let { items, disabled = false, hint, onchange }: { items: string[]; disabled?: boolean; hint?: string; onchange: (next: string[]) => void | Promise<void> } = $props();

  const OTHER = '__other';
  let other = $state(false);
  let draft = $state('');
  let bad = $state(false);
  const id = `ctry-${Math.random().toString(36).slice(2, 8)}`;
  const free = $derived(countryOptions(lang).filter((o) => !items.includes(o.tag)));

  function pick(value: string, el: HTMLSelectElement) {
    if (value === OTHER) { other = true; el.value = ''; return; }
    if (value) void onchange([...items, value]);
    el.value = '';
  }
  function addOther() {
    let v = draft.trim().toLowerCase();
    if (!v) return;
    if (!v.includes(':')) v = `en:${v}`;
    if (!/^[a-z]{2}:[a-z0-9-]{2,40}$/.test(v)) { bad = true; return; }
    bad = false;
    draft = '';
    other = false;
    if (!items.includes(v)) void onchange([...items, v]);
  }
  const remove = (v: string) => void onchange(items.filter((x) => x !== v));
</script>

<div class="ctry">
  <span class="lab" id="{id}-l">{t('admCountries')}</span>
  <ul class="chips" aria-labelledby="{id}-l">
    {#each items as v (v)}
      <li>
        <span>{countryName(v, lang)}</span>
        <button type="button" {disabled} aria-label={t('admRemoveItem', { name: countryName(v, lang) })} title={v} onclick={() => remove(v)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </li>
    {/each}
    <li class="add">
      <label class="sr-only" for={id}>{t('admCountryAdd')}</label>
      <select {id} {disabled} onchange={(e) => pick(e.currentTarget.value, e.currentTarget)}>
        <option value="">{t('admCountryAdd')}</option>
        {#each free as o (o.tag)}<option value={o.tag}>{o.name}</option>{/each}
        <option value={OTHER}>{t('admCountryOther')}</option>
      </select>
    </li>
  </ul>
  {#if other}
    <div class="otherrow">
      <label class="sr-only" for="{id}-o">{t('admCountryOtherLabel')}</label>
      <input id="{id}-o" type="text" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="en:new-zealand" {disabled} bind:value={draft} aria-invalid={bad}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOther(); } else if (e.key === 'Escape') { other = false; bad = false; } }} />
      <button type="button" class="btn" {disabled} onclick={addOther}>{t('admAdd')}</button>
    </div>
  {/if}
  {#if bad}<p class="note warn" role="alert">{t('admListBad')}</p>{:else if other}<p class="note">{t('admCountryOtherHint')}</p>{:else if hint}<p class="note">{hint}</p>{/if}
</div>

<style>
  .ctry { display: flex; flex-direction: column; gap: 8px; }
  .lab { font-size: 13px; font-weight: 600; color: var(--quiet); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  li { display: inline-flex; align-items: center; min-height: 44px; padding: 0 4px 0 14px; border-radius: 22px 22px 22px 8px; background: var(--sel-bg); color: var(--sel-fg); font-size: 14px; font-weight: 600; gap: 2px; }
  li button { width: 44px; height: 44px; border-radius: 22px; display: inline-flex; align-items: center; justify-content: center; color: inherit; --focus: var(--lime); }
  li button:focus-visible { outline-color: var(--lime); outline-offset: -4px; }
  li.add { padding: 0; background: transparent; }
  select { min-height: 44px; padding: 0 12px; color: var(--text); border-radius: 22px 22px 22px 8px; background: var(--stone); border: 2px solid var(--field-line); font-size: 14px; font-weight: 600; max-width: 100%; }
  .otherrow { display: flex; gap: 8px; }
  .otherrow input { flex: 1; min-width: 0; min-height: 48px; padding: 0 16px; border-radius: 16px; background: var(--stone); border: 2px solid var(--field-line); font-size: 16px; font-family: var(--f-mono); }
  .otherrow input:focus-visible { outline-offset: 0; border-color: var(--focus-base); }
  .otherrow input[aria-invalid='true'] { border-color: var(--warn); }
  .otherrow .btn { min-height: 48px; }
</style>
