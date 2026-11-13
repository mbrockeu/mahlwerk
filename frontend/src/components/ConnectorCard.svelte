<script lang="ts">
  // One connector of the admin area: a compact card (name, one sentence, state label, ONE switch in the head, a short fact) that opens
  // with "Settings". The technical notes for the operator (commands, environment variables, installation) sit in a folded section inside.
  import type { Snippet } from 'svelte';
  import { t } from '../lib/i18n';
  import { toast } from '../lib/store.svelte';
  import type { TechItem } from '../lib/types';
  import Icon from './Icon.svelte';
  import Toggle from './Toggle.svelte';

  let { id, title, desc, status, tone, unofficial = false, sw, lockedBy = '', fact = '', expandable = false, open, ontoggle, tech = [], techOpen = false, children }: {
    id: string; title: string; desc: string; status: string; tone: 'on' | 'off' | 'todo' | 'bad'; unofficial?: boolean;
    sw?: { checked: boolean; disabled: boolean; onchange: () => void };
    /** Set when the environment fixes the switch: the name of the variable (shown as a small label, the switch is disabled). */
    lockedBy?: string; fact?: string; expandable?: boolean; open: boolean; ontoggle: () => void;
    tech?: TechItem[]; techOpen?: boolean; children?: Snippet;
  } = $props();

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast(t('admCopied')); } catch { toast(t('admCopyFailed')); }
  }
</script>

<article class="cn" class:open aria-labelledby="{id}-h">
  <header>
    <div class="who">
      <h4 id="{id}-h">{title}</h4>
      <span class="tags">
        <span class="pill-state {tone}">{status}</span>
        {#if unofficial}<span class="pill-state warnt">{t('admUnofficial')}</span>{/if}
        {#if lockedBy}<span class="pill-state lock" title={t('admLockedBy', { name: lockedBy })}>{t('admLockedShort')}<span class="sr-only">: {t('admLockedBy', { name: lockedBy })}</span></span>{/if}
      </span>
    </div>
    <div class="ctl">
      {#if sw}<Toggle bare checked={sw.checked} label={title} disabled={sw.disabled} onchange={sw.onchange} />{/if}
      {#if expandable}
        <button type="button" class="more" aria-expanded={open} aria-controls="{id}-body" aria-label="{title}: {t('admSettings')}" title={t('admSettings')} onclick={ontoggle}>
          <span class="chev" aria-hidden="true"><Icon name="down" size={20} stroke={2.4} /></span>
        </button>
      {:else if sw}<span class="gap" aria-hidden="true"></span>{/if}
    </div>
  </header>
  <p class="one">{desc}</p>
  {#if fact}<p class="fact mono">{fact}</p>{/if}
  {#if expandable && open}
    <div class="body" id="{id}-body" role="group" aria-label="{title}: {t('admSettings')}">
      {@render children?.()}
      {#if tech.length}
        <details class="tech" open={techOpen}>
          <summary>{t('admTech')}</summary>
          <ul>
            {#each tech as item, i (i)}
              <li>
                {#if item.text}<span>{item.text}</span>{/if}
                {#if item.cmd}
                  <span class="cmd"><code>{item.cmd}</code><button type="button" class="cp" onclick={() => copy(item.cmd ?? '')} aria-label={t('admCopyAria', { what: item.cmd ?? '' })} title={t('admCopy')}><Icon name="copy" size={16} stroke={2.2} /></button></span>
                {/if}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    </div>
  {/if}
</article>

<style>
  .cn { background: var(--paper); border-radius: 24px 24px 24px 8px; padding: 10px 6px 14px 18px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 48px; }
  .who { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; }
  h4 { margin: 0; font-size: 16.5px; font-weight: 600; line-height: 1.25; }
  .tags { display: inline-flex; flex-wrap: wrap; gap: 6px; }
  .ctl { display: inline-flex; align-items: center; gap: 0; flex-shrink: 0; }
  .one { margin: 0 12px 0 0; font-size: 13.5px; line-height: 1.4; color: var(--quiet); }
  .fact { margin: 4px 12px 0 0; font-size: 12.5px; font-weight: 500; overflow-wrap: anywhere; }
  .more { width: 44px; height: 44px; border-radius: 22px; display: inline-flex; align-items: center; justify-content: center; color: var(--text); background: var(--stone); margin-left: 2px; }
  .more:hover { background: var(--hairline); }
  .gap { width: 46px; }
  .chev { display: inline-flex; transition: transform 160ms; }
  .more[aria-expanded='true'] .chev { transform: rotate(180deg); }
  .pill-state.on { background: var(--lime); color: var(--on-lime); }
  .pill-state.off { background: var(--track); color: var(--text); }
  .pill-state.todo { background: transparent; color: var(--warn); box-shadow: inset 0 0 0 1.5px var(--warn); }
  .pill-state.bad { background: var(--warn); color: #fff; }
  :global(:root[data-theme='dark']) .pill-state.bad { color: #17130f; }
  .pill-state.warnt { background: transparent; color: var(--text); box-shadow: inset 0 0 0 1.5px var(--hairline); }
  .pill-state.lock { background: transparent; color: var(--quiet); box-shadow: inset 0 0 0 1.5px var(--hairline); }
  .body { display: flex; flex-direction: column; gap: 14px; padding: 14px 12px 4px 0; border-top: 1px solid var(--hairline); margin-top: 10px; }
  .tech { border-radius: 16px 16px 16px 6px; background: var(--stone); padding: 0 14px; }
  .tech summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; font-family: var(--f-mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--quiet); list-style: none; }
  .tech summary::-webkit-details-marker { display: none; }
  .tech summary::after { content: '+'; margin-left: auto; font-size: 16px; }
  .tech[open] summary::after { content: '–'; }
  .tech ul { display: flex; flex-direction: column; gap: 10px; padding: 0 0 12px; margin: 0; list-style: none; }
  .tech li { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text); line-height: 1.4; }
  .cmd { display: flex; align-items: center; gap: 6px; background: var(--paper); border-radius: 12px; padding: 2px 2px 2px 10px; min-width: 0; }
  .cmd code { flex: 1; min-width: 0; font-family: var(--f-mono); font-size: 12.5px; padding: 6px 0; background: none; overflow-wrap: anywhere; }
  .cp { width: 44px; height: 44px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--text); }
  .cp:hover { background: var(--stone); }
  @media (min-width: 900px) { .cn.open { grid-column: 1 / -1; } }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
</style>
