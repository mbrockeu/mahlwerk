<script lang="ts">
  import { fmt, lang, t } from '../lib/i18n';
  import { blockedReason, MAX_PICK, PICK_GROUPS, togglePick, type PickGroup, type PickItem } from '../lib/nutrientCompare';
  import Icon from './Icon.svelte';
  import SearchField from './SearchField.svelte';
  import SeriesMark from './SeriesMark.svelte';
  import Sheet from './Sheet.svelte';

  // Up to four nutrients as removable chips; "Add" opens a sheet with a searchable list in groups. Every switch applies at once.
  let { items, sel, onsel }: { items: PickItem[]; sel: string[]; onsel: (next: string[]) => void } = $props();

  const byKey = $derived(new Map(items.map((i) => [i.key, i])));
  const refOf = (k: string) => byKey.get(k)?.ref ?? null;
  const nameOf = (k: string) => byKey.get(k)?.name ?? k;
  let open = $state(false);
  let query = $state('');
  const norm = (s: string) => s.toLocaleLowerCase(lang).normalize('NFD').replace(/\p{M}/gu, '');
  const groupLabel = (g: PickGroup) => t(({ macro: 'nutGroupMacro', vitamin: 'nutGroupVitamin', mineral: 'nutGroupMineral', other: 'nutGroupOther' } as const)[g]);
  const groups = $derived(PICK_GROUPS.map((g) => ({
    g, rows: items.filter((i) => i.group === g && (!query.trim() || norm(i.name).includes(norm(query.trim())))),
  })).filter((x) => x.rows.length));
  const lone = $derived(sel.length === 1 && !refOf(sel[0]) ? sel[0] : null);
  const full = $derived(sel.length >= MAX_PICK);

  function toggle(key: string) {
    const next = togglePick(sel, key, refOf);
    if (next.join() !== sel.join()) onsel(next);
  }
  const reason = (key: string) => {
    const r = blockedReason(sel, key, refOf);
    return r === 'noref' ? t('nutNoRef') : r === 'max' ? t('nutMaxReached', { n: MAX_PICK }) : r === 'last' ? t('nutOnlyOne') : '';
  };
  const refHint = (i: PickItem) => (i.ref ? t('nutRefHint', { n: fmt(i.ref.value, i.ref.value < 10 ? 1 : 0), unit: i.unit }) : t('nutNoRef'));
</script>

<div class="chips" role="group" aria-label={t('nutSelected')}>
  {#each sel as k, i (k)}
    <span class="chip-sel">
      <SeriesMark {i} width={26} />
      <span class="nm">{nameOf(k)}</span>
      <button type="button" class="x" disabled={sel.length === 1} aria-label={t('nutRemove', { name: nameOf(k) })}
        onclick={() => onsel(sel.filter((x) => x !== k))}><Icon name="close" size={14} stroke={2.6} /></button>
    </span>
  {/each}
  <button type="button" class="add" onclick={() => { query = ''; open = true; }} disabled={false} aria-haspopup="dialog">
    <Icon name="plus" size={16} stroke={2.6} />{t('nutAdd')}{#if full}<span class="cap mono">{sel.length}/{MAX_PICK}</span>{/if}
  </button>
</div>

{#if open}
  <Sheet title={t('nutPickTitle')} onclose={() => (open = false)} tall>
    <p class="hint">{t('nutPickHint', { n: MAX_PICK })}</p>
    <SearchField bind:value={query} placeholder={t('nutSearch')} />
    {#if lone}<p class="note lone">{t('nutAloneNote', { name: nameOf(lone) })}</p>{/if}
    {#each groups as grp (grp.g)}
      <section aria-labelledby="pg-{grp.g}">
        <h3 id="pg-{grp.g}" class="micro quiet">{groupLabel(grp.g)}</h3>
        <ul class="list">
          {#each grp.rows as it (it.key)}
            {@const on = sel.includes(it.key)}
            {@const why = reason(it.key)}
            {@const off = !on && !!blockedReason(sel, it.key, refOf)}
            <li>
              <button type="button" class="row" class:on class:off role="checkbox" aria-checked={on} aria-disabled={off || (on && sel.length === 1)} onclick={() => toggle(it.key)}>
                <span class="box" aria-hidden="true">{#if on}<Icon name="check" size={16} stroke={3} />{/if}</span>
                <span class="txt"><strong>{it.name}</strong><span class="sub">{off ? why : refHint(it)}</span></span>
                {#if on}<SeriesMark i={sel.indexOf(it.key)} width={26} />{/if}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {:else}<p class="note">{t('nutNoMatch')}</p>{/each}
    <button type="button" class="done" onclick={() => (open = false)}>{t('close')}</button>
  </Sheet>
{/if}

<style>
  .chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .chip-sel { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 6px 0 12px; background: var(--stone); border-radius: 20px 20px 20px 7px; font-size: 14px; font-weight: 600; max-width: 100%; }
  .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .x { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; color: var(--quiet); flex-shrink: 0; }
  .x:hover:not(:disabled) { background: var(--track); color: var(--text); }
  .x:disabled { opacity: 0.35; cursor: default; }
  .add { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 16px 0 12px; border-radius: 20px 20px 20px 7px; background: var(--sel-bg); color: var(--sel-fg); font-size: 14px; font-weight: 600; }
  .cap { font-size: 11px; opacity: 0.8; }
  .hint { font-size: 13px; color: var(--quiet); line-height: 1.35; }
  .lone { background: var(--stone); border-radius: 14px 14px 14px 5px; padding: 10px 12px; }
  section { display: flex; flex-direction: column; gap: 6px; }
  .list { display: flex; flex-direction: column; gap: 6px; }
  .row { width: 100%; display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 6px 14px 6px 10px; background: var(--paper); border-radius: 18px 18px 18px 6px; text-align: left; }
  .row.on { background: var(--stone); box-shadow: inset 0 0 0 2px var(--text); }
  .row.off { opacity: 0.55; cursor: not-allowed; }
  .box { width: 26px; height: 26px; flex-shrink: 0; border-radius: 9px 9px 9px 3px; box-shadow: inset 0 0 0 2px var(--field-line); display: grid; place-items: center; color: var(--sel-fg); }
  .row.on .box { background: var(--sel-bg); box-shadow: none; }
  .txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  strong { font-size: 15px; font-weight: 600; line-height: 1.2; }
  .sub { font-size: 12px; color: var(--quiet); }
  .row:focus-visible { outline: 3px solid var(--focus-base); outline-offset: 2px; }
  .done { min-height: 48px; border-radius: 24px 24px 24px 8px; background: var(--primary); color: #fff; font-weight: 600; font-size: 16px; margin-top: 4px; }
</style>
