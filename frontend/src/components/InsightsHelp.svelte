<script lang="ts">
  import { t } from '../lib/i18n';
  import { INSIGHTS_HELP } from '../lib/help';
  import Sheet from './Sheet.svelte';

  // The help of the evaluation page: what each card shows, what it needs, and a jump to it. Cards that are not on the page
  // right now (nothing logged in the period) are still explained, with a note instead of the jump.
  let { onclose, onjump }: { onclose: () => void; onjump: (target: string) => void } = $props();

  const tx = (key: string, p?: Record<string, string>) => t(key as 'hlpOpen', p);
  // which targets exist is read once when the sheet opens; the page behind does not change while it is open
  const present = new Set(INSIGHTS_HELP.filter((e) => e.target && document.getElementById(e.target)).map((e) => e.target as string));
</script>

<Sheet title={t('hlpTitle')} {onclose} tall>
  <div class="help">
    <p class="intro">{t('hlpIntro')}</p>
    <ul class="list">
      {#each INSIGHTS_HELP as e (e.id)}
        <li class="entry">
          <div class="head">
            <h3>{tx(e.title)}</h3>
            {#if e.target && present.has(e.target)}
              <button class="chip small" onclick={() => onjump(e.target as string)} aria-label={tx('hlpShowAria', { name: tx(e.title) })}>{t('hlpShow')}</button>
            {/if}
          </div>
          <p>{tx(`hlp_${e.id}`)}</p>
          {#if e.needs}
            <p class="needs">{t('hlpNeeds')}</p>
            <ul class="needlist">{#each e.needs as n}<li>{tx(n)}</li>{/each}</ul>
          {/if}
          {#if e.target && !present.has(e.target)}<p class="note">{t('hlpHidden')}</p>{/if}
        </li>
      {/each}
    </ul>
  </div>
</Sheet>

<style>
  .help { display: flex; flex-direction: column; gap: 14px; padding-bottom: 8px; }
  .intro { color: var(--quiet); }
  .list { display: flex; flex-direction: column; gap: 10px; }
  .entry { background: var(--paper); border-radius: 22px 22px 22px 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  h3 { font-size: 16px; font-weight: 700; line-height: 1.2; }
  .chip.small { min-height: 36px; padding: 0 14px; font-size: 13px; flex-shrink: 0; }
  p { font-size: 14px; line-height: 1.45; }
  .needs { font-weight: 600; margin-top: 2px; }
  .needlist { list-style: disc; padding-left: 20px; font-size: 14px; line-height: 1.45; }
  .note { font-size: 13px; color: var(--quiet); }
</style>
