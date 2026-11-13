<script lang="ts">
  // Admin area, local sign-in mode: add users, block, reset a password, give or take the admin right.
  // oidc mode: the list with blocking only (accounts and the admin right come from the provider).
  import { api, ApiError } from '../lib/api';
  import { nameValid, normalizeName, passwordProblem } from '../lib/account';
  import { t } from '../lib/i18n';
  import { auth, toast, ui } from '../lib/store.svelte';
  import type { AdminUser } from '../lib/types';

  let { users, onchange }: { users: AdminUser[]; onchange: () => void | Promise<void> } = $props();

  let name = $state('');
  let display = $state('');
  let password = $state('');
  let makeAdmin = $state(false);
  let busy = $state('');
  let error = $state('');
  let confirmBlock = $state('');
  let resetFor = $state('');
  let resetPassword = $state('');

  const me = $derived(ui.me?.username);
  const oidc = $derived(auth.mode === 'oidc');
  const fail = (err: unknown) => {
    if (err instanceof ApiError && err.status === 409) return err.detail === 'this user name is taken' ? t('usrTaken') : t('usrLastAdmin');
    if (err instanceof ApiError && err.status === 422) return err.detail === 'this user name is reserved' ? t('usrReserved') : t('authNameBad');
    return t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
  };

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    const bad = passwordProblem(password);
    if (!nameValid(name)) { error = t('authNameBad'); return; }
    if (bad) { error = bad === 'short' ? t('authShort') : t('authLong'); return; }
    busy = 'create';
    error = '';
    try {
      const made = await api.createUser({ username: normalizeName(name), display_name: display.trim(), password, is_admin: makeAdmin });
      toast(t('usrCreated', { name: made.username }));
      name = display = password = '';
      makeAdmin = false;
      await onchange();
    } catch (err) { error = fail(err); } finally { busy = ''; }
  }

  async function patch(u: AdminUser, body: { disabled?: boolean; is_admin?: boolean }, done: 'usrBlockedDone' | 'usrUnblockedDone' | 'usrAdminDone') {
    busy = u.username;
    error = '';
    try {
      await api.patchUser(u.username, body);
      confirmBlock = '';
      toast(t(done, { name: u.username }));
      await onchange();
    } catch (err) { error = fail(err); } finally { busy = ''; }
  }

  const block = (u: AdminUser) => {
    if (confirmBlock !== u.username) { confirmBlock = u.username; return; }
    void patch(u, { disabled: true }, 'usrBlockedDone');
  };

  async function reset(e: SubmitEvent, u: AdminUser) {
    e.preventDefault();
    const bad = passwordProblem(resetPassword);
    if (bad) { error = bad === 'short' ? t('authShort') : t('authLong'); return; }
    busy = u.username;
    error = '';
    try {
      await api.resetPassword(u.username, resetPassword);
      toast(t('usrResetDone', { name: u.username }));
      resetFor = resetPassword = '';
      await onchange();
    } catch (err) { error = fail(err); } finally { busy = ''; }
  }
</script>

<section class="icard" aria-labelledby="usr-title">
  <h2 id="usr-title" class="micro quiet">{t('usrManage')}</h2>
  <ul class="list">
    {#each users as u (u.username)}
      <li class="row" class:off={u.disabled}>
        <div class="who">
          <strong>{u.display_name}</strong>
          <small class="mono">{u.username}</small>
          <span class="tags">
            {#if u.admin}<span class="tag lime">{t('usrAdmin')}</span>{/if}
            {#if u.disabled}<span class="tag">{t('usrBlockedTag')}</span>{/if}
            {#if oidc}{#if !u.sso}<span class="tag">{t('usrNotSignedIn')}</span>{/if}
            {:else if !u.has_password}<span class="tag">{t('usrNoPassword')}</span>{/if}
          </span>
        </div>
        <div class="acts">
          {#if u.disabled}
            <button type="button" class="btn small" disabled={busy === u.username} onclick={() => patch(u, { disabled: false }, 'usrUnblockedDone')}>{t('usrUnblock')}</button>
          {:else}
            <button type="button" class="btn small danger" disabled={busy === u.username || (oidc && u.username === me)} onclick={() => block(u)}>{confirmBlock === u.username ? t('usrBlockSure') : t('usrBlock')}</button>
          {/if}
          {#if !oidc}<button type="button" class="btn small" disabled={busy === u.username} onclick={() => patch(u, { is_admin: !u.admin }, 'usrAdminDone')}>{u.admin ? t('usrRemoveAdmin') : t('usrMakeAdmin')}</button>{/if}
          {#if !oidc && u.username !== me}
            <button type="button" class="btn small" aria-expanded={resetFor === u.username} onclick={() => { resetFor = resetFor === u.username ? '' : u.username; resetPassword = ''; }}>{t('usrReset')}</button>
          {/if}
        </div>
        {#if resetFor === u.username}
          <form class="reset" onsubmit={(e) => reset(e, u)} novalidate>
            <div class="field">
              <label for={`rp-${u.username}`}>{t('usrResetFor', { name: u.username })}</label>
              <input id={`rp-${u.username}`} type="text" bind:value={resetPassword} autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="300" />
              <p class="note">{t('authRule')}</p>
            </div>
            <button type="submit" class="btn primary small" disabled={busy === u.username}>{t('usrResetSave')}</button>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
  {#if error}<p class="note warn" role="alert">{error}</p>{/if}
  <p class="note">{t('usrManageNote')}</p>
  {#if oidc}<p class="note">{t('usrOidcNote')}</p>{/if}

  {#if !oidc}
  <h3 class="sub">{t('usrAdd')}</h3>
  <p class="note">{t('usrAddText')}</p>
  <form onsubmit={create} novalidate class="add">
    <div class="field">
      <label for="nu-name">{t('authUser')}</label>
      <input id="nu-name" type="text" bind:value={name} autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="40" />
    </div>
    <div class="field">
      <label for="nu-display">{t('authDisplay')}</label>
      <input id="nu-display" type="text" bind:value={display} autocomplete="off" maxlength="80" />
    </div>
    <div class="field">
      <label for="nu-pw">{t('authPassword')}</label>
      <input id="nu-pw" type="text" bind:value={password} autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="300" aria-describedby="nu-rule" />
      <p id="nu-rule" class="note">{t('authRule')}</p>
    </div>
    <label class="check"><input type="checkbox" bind:checked={makeAdmin} /><span>{t('usrAdmin')}</span></label>
    <button type="submit" class="btn primary" disabled={busy === 'create'}>{t('usrCreate')}</button>
  </form>
  {/if}
</section>

<style>
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .row { background: var(--stone); border-radius: 20px 20px 20px 8px; padding: 12px 14px 12px 16px; display: flex; flex-direction: column; gap: 10px; }
  .row.off .who strong { text-decoration: line-through; text-decoration-thickness: 1px; }
  .who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
  .who strong { font-weight: 600; font-size: 15px; }
  .who small { font-size: 12px; color: var(--quiet); }
  .tags { display: flex; gap: 6px; flex-basis: 100%; }
  .tag { font-family: var(--f-mono); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; padding: 2px 8px; border-radius: 8px; background: var(--paper); border: 1px solid var(--hairline); }
  .tag.lime { background: var(--lime); color: var(--on-lime); border-color: var(--lime); }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .reset, .add { display: flex; flex-direction: column; gap: 12px; }
  .field label { font-size: 13px; font-weight: 600; color: var(--quiet); }
  .row .field input, .icard .add .field input { background: var(--paper); }
  .sub { font-family: var(--f-display); font-weight: 800; font-size: 20px; letter-spacing: -0.02em; margin-top: 6px; }
  .check { background: var(--stone); }
  @media (min-width: 900px) {
    .row { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; }
    .reset { flex-basis: 100%; }
    .add { max-width: 520px; }
  }
</style>
