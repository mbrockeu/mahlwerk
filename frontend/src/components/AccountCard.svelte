<script lang="ts">
  // Profile card in the modes with a session: change the own password (local only), sign out.
  import { api, ApiError } from '../lib/api';
  import { passwordProblem, waitText } from '../lib/account';
  import { t } from '../lib/i18n';
  import { auth, signOut, toast } from '../lib/store.svelte';

  let open = $state(false);
  let current = $state('');
  let next = $state('');
  let repeat = $state('');
  let busy = $state(false);
  let error = $state('');

  function reset() { current = next = repeat = ''; error = ''; open = false; }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    const bad = passwordProblem(next);
    if (!current) { error = t('authNeedPassword'); return; }
    if (bad) { error = bad === 'short' ? t('authShort') : t('authLong'); return; }
    if (next !== repeat) { error = t('authMismatch'); return; }
    busy = true;
    error = '';
    try {
      await api.changePassword({ current_password: current, new_password: next });
      reset();
      toast(t('acctDone'));
    } catch (err) {
      current = '';
      if (err instanceof ApiError && err.status === 403) error = t('acctWrong');
      else if (err instanceof ApiError && err.status === 429) error = t('authWait', { time: waitText(err.retryAfter ?? 60) });
      else error = t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      busy = false;
    }
  }
</script>

<section class="icard" aria-labelledby="acct-title">
  <h2 id="acct-title" class="micro quiet">{t('acctTitle')}</h2>
  {#if auth.mode === 'oidc'}
    <p class="note">{t('oidcAcctNote')}</p>
    <div class="acts">
      <button type="button" class="btn" onclick={signOut}>{t('acctSignOut')}</button>
    </div>
  {:else if open}
    <form onsubmit={save} novalidate>
      <div class="field">
        <label for="acct-cur">{t('acctCurrent')}</label>
        <input id="acct-cur" type="password" bind:value={current} autocomplete="current-password" maxlength="300" />
      </div>
      <div class="field">
        <label for="acct-new">{t('acctNew')}</label>
        <input id="acct-new" type="password" bind:value={next} autocomplete="new-password" maxlength="300" aria-describedby="acct-rule" />
        <p id="acct-rule" class="note">{t('authRule')}</p>
      </div>
      <div class="field">
        <label for="acct-rep">{t('acctNewRepeat')}</label>
        <input id="acct-rep" type="password" bind:value={repeat} autocomplete="new-password" maxlength="300" />
      </div>
      {#if error}<p class="note warn" role="alert">{error}</p>{/if}
      <p class="note">{t('acctNote')}</p>
      <div class="acts">
        <button type="submit" class="btn primary" disabled={busy}>{t('acctSave')}</button>
        <button type="button" class="btn quiet-btn" onclick={reset}>{t('cancel')}</button>
      </div>
    </form>
  {:else}
    <div class="acts">
      <button type="button" class="btn" onclick={() => (open = true)}>{t('acctChange')}</button>
      <button type="button" class="btn" onclick={signOut}>{t('acctSignOut')}</button>
    </div>
  {/if}
</section>

<style>
  form { display: flex; flex-direction: column; gap: 12px; }
  .field label { font-size: 13px; font-weight: 600; color: var(--quiet); }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
