<script lang="ts">
  // Manage the groups: make one, rename, delete (the recipes stay) and put them in order. Moving is done with up and down buttons
  // (no dragging: works with the keyboard and a screen reader). Every change is saved at once.
  import { api, ApiError } from '../lib/api';
  import { fmt, t } from '../lib/i18n';
  import type { RecipeGroup } from '../lib/types';
  import Icon from './Icon.svelte';

  let { groups, onchange }: { groups: RecipeGroup[]; onchange: () => Promise<void> | void } = $props();
  let name = $state('');
  let error = $state('');
  let editing = $state<number | null>(null);
  let draft = $state('');
  let confirming = $state<number | null>(null);
  let busy = $state(false);

  const why = (err: unknown) => (err instanceof ApiError && err.status === 409 ? t('grpTaken') : t('grpFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' }));
  async function run(work: () => Promise<unknown>) {
    busy = true;
    error = '';
    try { await work(); await onchange(); } catch (err) { error = why(err); } finally { busy = false; }
  }
  const add = () => { const n = name.trim(); if (n) void run(async () => { await api.createRecipeGroup(n); name = ''; }); };
  function begin(g: RecipeGroup) { editing = g.id; draft = g.name; confirming = null; error = ''; }
  const save = (g: RecipeGroup) => { const n = draft.trim(); if (!n || n === g.name) { editing = null; return; } void run(async () => { await api.renameRecipeGroup(g.id, n); editing = null; }); };
  const remove = (g: RecipeGroup) => run(async () => { await api.deleteRecipeGroup(g.id); confirming = null; });
  function move(i: number, by: -1 | 1) {
    const ids = groups.map((g) => g.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    void run(() => api.orderRecipeGroups(ids));
  }
</script>

<div class="gm">
  <form class="new" onsubmit={(e) => { e.preventDefault(); add(); }}>
    <label class="field"><span>{t('grpNew')}</span>
      <input bind:value={name} maxlength="60" autocomplete="off" placeholder={t('grpNameLabel')} />
    </label>
    <button class="btn primary" disabled={busy || !name.trim()}>{t('grpAdd')}</button>
  </form>
  {#if error}<p class="note warn" role="alert">{error}</p>{/if}

  {#if groups.length === 0}
    <p class="note">{t('grpEmpty')}</p>
  {:else}
    <ul class="rows">
      {#each groups as g, i (g.id)}
        <li class="item">
          {#if editing === g.id}
            <form class="edit" onsubmit={(e) => { e.preventDefault(); save(g); }}>
              <label class="field"><span class="sr-only">{t('grpRenameAria', { name: g.name })}</span><input bind:value={draft} maxlength="60" autocomplete="off" /></label>
              <button class="btn primary small" disabled={busy || !draft.trim()}>{t('grpSave')}</button>
              <button type="button" class="btn small" onclick={() => (editing = null)}>{t('cancel')}</button>
            </form>
          {:else}
            <div class="line">
              <span class="t"><strong>{g.name}</strong><small>{g.auto ? `${t('grpAuto')} · ` : ''}{fmt(g.count)}</small></span>
              <span class="tools">
                <button type="button" class="round" disabled={busy || i === 0} onclick={() => move(i, -1)} aria-label={t('grpUp', { name: g.name })}><Icon name="up" size={18} /></button>
                <button type="button" class="round" disabled={busy || i === groups.length - 1} onclick={() => move(i, 1)} aria-label={t('grpDown', { name: g.name })}><Icon name="down" size={18} /></button>
                <button type="button" class="round" onclick={() => begin(g)} aria-label={t('grpRenameAria', { name: g.name })} title={t('grpRename')}><Icon name="edit" size={18} /></button>
                <button type="button" class="round" onclick={() => { confirming = confirming === g.id ? null : g.id; }} aria-expanded={confirming === g.id} aria-label={`${t('grpDelete')}: ${g.name}`} title={t('grpDelete')}><Icon name="close" size={18} /></button>
              </span>
            </div>
            {#if confirming === g.id}
              <div class="confirm">
                <p class="note">{t('grpDeleteNote')}</p>
                <button type="button" class="btn danger small" disabled={busy} onclick={() => remove(g)}>{t('grpDeleteConfirm')}</button>
              </div>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .gm { display: flex; flex-direction: column; gap: 12px; }
  .new { display: flex; gap: 8px; align-items: flex-end; }
  .new .field { flex: 1; min-width: 0; }
  .new .btn { min-height: 48px; }
  .item { background: var(--paper); border-radius: 20px; padding: 6px 8px 6px 16px; display: flex; flex-direction: column; gap: 6px; }
  .line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0 6px; min-height: 52px; }
  .t { display: flex; flex-direction: column; min-width: 0; flex: 1 1 100px; }
  .t strong { font-size: 15px; font-weight: 600; overflow-wrap: break-word; }
  .t small { font-size: 12px; color: var(--quiet); }
  .tools { display: flex; gap: 2px; flex-shrink: 0; margin-left: auto; }
  .tools .round { background: transparent; }
  .tools .round:disabled { opacity: 0.35; }
  .edit { display: flex; gap: 6px; align-items: center; padding: 4px 0; flex-wrap: wrap; }
  .edit .field { flex: 1; min-width: 140px; }
  .btn.small { min-height: 44px; padding: 0 16px; font-size: 14px; }
  .confirm { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 8px 8px 0; flex-wrap: wrap; }
</style>
