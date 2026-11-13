<script lang="ts">
  // A password field with a "show" button. The browser's own password manager is kept out of it on purpose: these are
  // credentials for ANOTHER service, never the Mahlwerk sign-in, so `autocomplete` is "new-password" (no filling in).
  import { t } from '../lib/i18n';

  let { id, label, value = $bindable(''), name, autocomplete = 'new-password', invalid = false, describedby }: {
    id: string; label: string; value: string; name: string; autocomplete?: 'new-password' | 'off'; invalid?: boolean; describedby?: string;
  } = $props();
  let shown = $state(false);
</script>

<div class="field">
  <label for={id}>{label}</label>
  <div class="pw">
    <input {id} {name} type={shown ? 'text' : 'password'} bind:value {autocomplete} autocapitalize="off" autocorrect="off" spellcheck="false"
      maxlength="500" aria-invalid={invalid ? 'true' : undefined} aria-describedby={describedby} />
    <button type="button" class="show" aria-pressed={shown} aria-label={shown ? t('ckaHideAria') : t('ckaShowAria')} onclick={() => (shown = !shown)}>
      {shown ? t('ckaHide') : t('ckaShow')}
    </button>
  </div>
</div>

<style>
  label { font-size: 13px; font-weight: 600; color: var(--quiet); }
  .pw { position: relative; display: flex; }
  .pw input { padding-right: 96px; background: var(--stone); }
  .show { position: absolute; right: 4px; top: 4px; bottom: 4px; min-width: 76px; padding: 0 14px; border-radius: 12px 12px 12px 5px; background: var(--paper); border: 2px solid var(--hairline); font-size: 13px; font-weight: 600; }
  .show[aria-pressed='true'] { background: var(--sel-bg); color: var(--sel-fg); border-color: var(--sel-bg); }
</style>
