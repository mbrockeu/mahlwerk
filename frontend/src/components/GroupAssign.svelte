<script lang="ts">
  // The groups of ONE recipe as chips to switch on and off (saved at once), and a field to make a new group right there.
  // Used in the detail pane, in the sheet of a Cookidoo recipe and in the recipe editor.
  import { api, ApiError } from '../lib/api';
  import { t } from '../lib/i18n';
  import type { RecipeGroup } from '../lib/types';
  import Icon from './Icon.svelte';

  let { foodId, groups, onchange }: { foodId: number; groups: RecipeGroup[]; onchange: () => Promise<void> | void } = $props();
  let busy = $state(false);
  let error = $state('');
  let name = $state('');
  const mine = $derived(groups.filter((g) => g.food_ids.includes(foodId)).map((g) => g.id));

  const why = (err: unknown) => (err instanceof ApiError && err.status === 409 ? t('grpTaken') : t('grpFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' }));
  async function run(work: () => Promise<unknown>) {
    busy = true;
    error = '';
    try { await work(); await onchange(); } catch (err) { error = why(err); } finally { busy = false; }
  }
  const toggle = (g: RecipeGroup) => run(() => api.setRecipeGroups(foodId, mine.includes(g.id) ? mine.filter((i) => i !== g.id) : [...mine, g.id]));
  const create = () => {
    const n = name.trim();
    if (!n) return;
    void run(async () => { const made = await api.createRecipeGroup(n); await api.setRecipeGroups(foodId, [...mine, made.id]); name = ''; });
  };
</script>

<section class="ga" aria-labelledby="ga-h">
  <h3 id="ga-h" class="micro quiet">{t('grpOfRecipe')}</h3>
  <p class="note">{t('grpOfRecipeHint')}</p>
  <div class="chips">
    {#each groups as g (g.id)}
      <button type="button" class="chip" class:on={mine.includes(g.id)} aria-pressed={mine.includes(g.id)} disabled={busy} onclick={() => toggle(g)}>
        {#if mine.includes(g.id)}<Icon name="check" size={16} stroke={2.6} />{/if}{g.name}
      </button>
    {/each}
  </div>
  <!-- not a form: the recipe editor around it is one -->
  <div class="new">
    <label class="field"><span class="sr-only">{t('grpNew')}</span>
      <input bind:value={name} maxlength="60" autocomplete="off" placeholder={t('grpInline')} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }} />
    </label>
    <button type="button" class="btn" disabled={busy || !name.trim()} onclick={create}>{t('grpAdd')}</button>
  </div>
  {#if error}<p class="note warn" role="alert">{error}</p>{/if}
</section>

<style>
  .ga { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 18px 22px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { max-width: 100%; }
  .chip:disabled { opacity: 0.7; }
  .new { display: flex; gap: 8px; align-items: center; }
  .new .field { flex: 1; min-width: 0; }
  .new .btn { min-height: 48px; }
</style>
