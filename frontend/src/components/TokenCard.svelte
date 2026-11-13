<script lang="ts">
  // Profile card "Access keys": create a personal key (shown once), list them, revoke them.
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmtDate, t } from '../lib/i18n';
  import { toast } from '../lib/store.svelte';
  import type { AccessToken, TokenScope } from '../lib/types';
  import Icon from './Icon.svelte';

  const EXPIRY = [{ days: 0, label: () => t('tokNever') }, { days: 30, label: () => t('tokDays', { n: 30 }) }, { days: 90, label: () => t('tokDays', { n: 90 }) }, { days: 365, label: () => t('tokYear') }];

  let tokens = $state<AccessToken[]>([]);
  let loaded = $state(false);
  let name = $state('');
  let scope = $state<TokenScope>('read');
  let days = $state(0);
  let busy = $state(false);
  let error = $state('');
  let nameBad = $state(false);
  /** The clear text of the key just created; it lives only here, until the person dismisses it. */
  let fresh = $state<string | null>(null);
  let copied = $state(false);
  let copyFailed = $state(false);
  let confirm = $state<number | null>(null);
  let secretEl = $state<HTMLElement>();

  const reason = (err: unknown) => (err instanceof ApiError ? err.status || err.message : 'error');
  const load = async () => { try { tokens = await api.tokens(); } catch { tokens = []; } loaded = true; };
  onMount(() => { void load(); });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) { nameBad = true; return; }
    nameBad = false;
    busy = true;
    error = '';
    try {
      const made = await api.createToken({ name: name.trim(), scope, ...(days ? { expires_in_days: days } : {}) });
      fresh = made.token;
      copied = copyFailed = false;
      name = '';
      await load();
    } catch (err) {
      error = t('saveFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }

  async function copy() {
    if (fresh == null) return;
    try {
      await navigator.clipboard.writeText(fresh);
      copied = true;
      copyFailed = false;
    } catch {
      copyFailed = true;
      if (secretEl) { const r = document.createRange(); r.selectNodeContents(secretEl); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); }
    }
  }

  async function revoke(id: number) {
    if (confirm !== id) { confirm = id; return; }
    busy = true;
    try {
      await api.revokeToken(id);
      confirm = null;
      toast(t('tokRevoked'));
      await load();
    } catch (err) {
      error = t('saveFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }

  const now = () => Date.now() / 1000;
  function stateText(k: AccessToken): string {
    if (k.revoked_at) return t('tokRevokedOn', { date: fmtDate(k.revoked_at) });
    if (k.expires_at && k.expires_at <= now()) return t('tokExpired', { date: fmtDate(k.expires_at) });
    return k.expires_at ? t('tokExpires', { date: fmtDate(k.expires_at) }) : '';
  }
  const live = (k: AccessToken) => !k.revoked_at && !(k.expires_at && k.expires_at <= now());
</script>

<section class="icard" aria-labelledby="tok-title">
  <h2 id="tok-title" class="micro quiet">{t('tokTitle')}</h2>
  <p class="note">{t('tokText')}</p>

  {#if fresh}
    <div class="reveal" role="group" aria-labelledby="tok-new">
      <span id="tok-new" class="micro">{t('tokKeyLabel')}</span>
      <div class="secret" bind:this={secretEl} data-testid="token-secret">{fresh}</div>
      <p><strong>{t('tokShownOnce')}</strong></p>
      <p>{t('tokUse')}</p>
      <div class="acts">
        <button type="button" onclick={copy}><Icon name={copied ? 'check' : 'copy'} size={18} stroke={2.4} />{copied ? t('tokCopied') : t('tokCopy')}</button>
        <button type="button" class="ghost" onclick={() => (fresh = null)}>{t('tokDone')}</button>
      </div>
      {#if copyFailed}<p role="alert">{t('tokCopyFailed')}</p>{/if}
    </div>
  {:else}
    <form onsubmit={create} novalidate>
      <div class="field">
        <span id="tok-name-l">{t('tokName')}</span>
        <input type="text" aria-labelledby="tok-name-l" placeholder={t('tokNamePh')} maxlength="80" autocomplete="off" bind:value={name} aria-invalid={nameBad} />
        {#if nameBad}<p class="note warn" role="alert">{t('tokBadName')}</p>{/if}
      </div>
      <div class="field">
        <span id="tok-scope-l">{t('tokScope')}</span>
        <div class="chips" role="group" aria-labelledby="tok-scope-l">
          <button type="button" class="chip" class:on={scope === 'read'} aria-pressed={scope === 'read'} onclick={() => (scope = 'read')}>{t('tokRead')}</button>
          <button type="button" class="chip" class:on={scope === 'write'} aria-pressed={scope === 'write'} onclick={() => (scope = 'write')}>{t('tokWrite')}</button>
        </div>
      </div>
      <div class="field">
        <span id="tok-exp-l">{t('tokExpiry')}</span>
        <div class="chips" role="group" aria-labelledby="tok-exp-l">
          {#each EXPIRY as e}
            <button type="button" class="chip" class:on={days === e.days} aria-pressed={days === e.days} onclick={() => (days = e.days)}>{e.label()}</button>
          {/each}
        </div>
      </div>
      <button class="btn primary" type="submit" disabled={busy}>{t('tokCreate')}</button>
    </form>
  {/if}
  {#if error}<p class="note warn" role="alert">{error}</p>{/if}

  {#if loaded && tokens.length === 0}
    <p class="note">{t('tokNone')}</p>
  {:else if tokens.length}
    <ul class="rows" aria-label={t('tokTitle')}>
      {#each tokens as k (k.id)}
        <li class="row-pill" class:gone={!live(k)}>
          <span class="t">
            <strong>{k.name}</strong>
            <small><span class="mono">{k.prefix}…</span> · {k.scope === 'write' ? t('tokWrite') : t('tokRead')}{#if stateText(k)} · {stateText(k)}{/if}</small>
            <small>{k.last_used_at ? t('tokLastUsed', { date: fmtDate(k.last_used_at) }) : t('tokNeverUsed')}</small>
          </span>
          {#if live(k)}
            <span class="acts">
              <button type="button" class="btn danger small" disabled={busy} aria-label={t('tokRevokeAria', { name: k.name })} onclick={() => revoke(k.id)}>{confirm === k.id ? t('tokRevokeConfirm') : t('tokRevoke')}</button>
              {#if confirm === k.id}<button type="button" class="btn quiet-btn small" onclick={() => (confirm = null)}>{t('cancel')}</button>{/if}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  form { display: flex; flex-direction: column; gap: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { border-radius: 22px 22px 22px 8px; }
  .gone { opacity: 0.6; }
  .acts { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; flex-shrink: 0; }
  .row-pill { border-radius: 20px 20px 20px 8px; }
</style>
