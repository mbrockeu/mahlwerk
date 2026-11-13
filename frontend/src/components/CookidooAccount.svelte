<script lang="ts">
  // One Cookidoo account: the shared household account (admin area, scope "shared") or a person's own (profile, scope "own").
  // The server never returns the password and shows the e-mail address masked; "Check connection" makes one sign-in attempt.
  import { onMount, tick } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { t } from '../lib/i18n';
  import { toast } from '../lib/store.svelte';
  import type { CookidooAccount, CookidooScope } from '../lib/types';
  import PasswordField from './PasswordField.svelte';

  let { scope, id, hideKey = false, onchange }: { scope: CookidooScope; id: string; hideKey?: boolean; onchange?: () => void } = $props();

  // country -> usual language of that Cookidoo site; the language stays editable
  const REGIONS: { country: string; language: string; name: string }[] = [
    { country: 'de', language: 'de-DE', name: 'Deutschland' }, { country: 'at', language: 'de-AT', name: 'Österreich' },
    { country: 'ch', language: 'de-CH', name: 'Schweiz' }, { country: 'fr', language: 'fr-FR', name: 'France' },
    { country: 'es', language: 'es-ES', name: 'España' }, { country: 'it', language: 'it-IT', name: 'Italia' },
    { country: 'pl', language: 'pl-PL', name: 'Polska' }, { country: 'pt', language: 'pt-PT', name: 'Portugal' },
    { country: 'gb', language: 'en-GB', name: 'United Kingdom' },
  ];

  let account = $state<CookidooAccount | null>(null);
  let loadError = $state('');
  let editing = $state(false);
  let email = $state('');
  let password = $state('');
  let country = $state('de');
  let language = $state('de-DE');
  let busy = $state(false);
  let checking = $state(false);
  let checkResult = $state<'' | 'ok'>('');
  let error = $state('');
  let formBad = $state(false);
  let confirmRemove = $state(false);
  let emailEl: HTMLInputElement | undefined = $state();
  let changeBtn: HTMLButtonElement | undefined = $state();

  const reason = (err: unknown) => (err instanceof ApiError ? (typeof err.detail === 'string' ? err.detail : String(err.status || err.message)) : 'error');

  async function load() {
    try { account = await api.cookidooAccount(scope); loadError = ''; } catch (err) { loadError = t('loadFailed', { reason: reason(err) }); }
  }
  onMount(() => { void load(); });

  const showForm = $derived(!!account && account.editable && (editing || account.source === 'none' || account.source === 'unreadable'));
  const canUse = $derived(!!account && account.editable);

  async function edit() {
    email = '';
    password = '';
    country = account?.country ?? 'de';
    language = account?.language ?? 'de-DE';
    editing = true;
    checkResult = '';
    error = '';
    await tick();
    emailEl?.focus();
  }
  function pickCountry(next: string) {
    country = next;
    const region = REGIONS.find((r) => r.country === next);
    if (region) language = region.language;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    checkResult = '';
    if (!email.trim() || !password || !/^[a-z]{2}$/i.test(country.trim()) || !/^[a-z]{2}-[A-Z]{2}$/.test(language.trim())) { formBad = true; return; }
    formBad = false;
    busy = true;
    try {
      account = await api.cookidooSetAccount(scope, { email: email.trim(), password, country: country.trim().toLowerCase(), language: language.trim() });
      password = '';
      email = '';
      editing = false;
      toast(t('ckaSaved'));
      onchange?.();
      await tick();
      changeBtn?.focus();
    } catch (err) {
      error = t('saveFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }

  async function check() {
    if (checking) return;
    checking = true;
    checkResult = '';
    error = '';
    try {
      await api.cookidooCheck(scope);
      checkResult = 'ok';
      await load();
      onchange?.();
    } catch (err) {
      error = reason(err);
      await load();
      onchange?.();
    } finally {
      checking = false;
    }
  }

  async function remove() {
    if (!confirmRemove) { confirmRemove = true; return; }
    busy = true;
    error = '';
    try {
      account = await api.cookidooRemoveAccount(scope);
      confirmRemove = false;
      editing = false;
      checkResult = '';
      toast(t('ckaRemoved'));
      onchange?.();
    } catch (err) {
      error = t('saveFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }
  const region = (a: CookidooAccount) => [a.country?.toUpperCase(), a.language].filter(Boolean).join(' · ');
</script>

{#snippet removeUi()}
        {#if confirmRemove}
    <span class="ask" role="group" aria-label={t('ckaRemove')}>
      <span>{t('ckaRemoveConfirm')}</span>
      <button type="button" class="btn" onclick={remove} disabled={busy}>{t('ckaRemoveYes')}</button>
      <button type="button" class="btn quiet-btn" onclick={() => (confirmRemove = false)}>{t('cancel')}</button>
    </span>
  {:else}
    <button type="button" class="btn quiet-btn" onclick={remove} disabled={busy}>{t('ckaRemove')}</button>
  {/if}
{/snippet}

<div class="acct" aria-live="polite">
  {#if loadError}
    <p class="note warn" role="alert">{loadError}</p>
  {:else if account}
    {#if account.source === 'env'}
      <p class="row mono"><strong>{account.email}</strong><span>{region(account)}</span></p>
      <p class="note">{t('ckaEnv')}</p>
    {:else if account.source === 'unreadable'}
      <p class="note warn" role="alert">{t('ckaUnreadable')}</p>
    {:else if account.source === 'stored'}
      <p class="row mono"><strong>{account.email}</strong><span>{region(account)}</span></p>
    {:else if !showForm}
      <p class="note">{t('ckaNone')}</p>
    {/if}

    {#if scope === 'own' && !account.allowed}
      <p class="note">{t('ckaOffByAdmin')}</p>
    {/if}

    {#if showForm}
      <form onsubmit={save} novalidate autocomplete="off">
        <div class="field">
          <label for={`${id}-email`}>{t('ckaEmail')}</label>
          <input id={`${id}-email`} name={`${id}-account`} type="email" inputmode="email" bind:this={emailEl} bind:value={email} autocomplete="off"
            autocapitalize="off" spellcheck="false" maxlength="200" aria-invalid={formBad && !email.trim() ? 'true' : undefined} />
        </div>
        <PasswordField id={`${id}-pw`} name={`${id}-secret`} label={t('ckaPassword')} bind:value={password} invalid={formBad && !password} />
        <div class="two">
          <div class="field">
            <label for={`${id}-country`}>{t('ckaCountry')}</label>
            <select id={`${id}-country`} value={country} onchange={(e) => pickCountry(e.currentTarget.value)}>
              {#each REGIONS as r (r.country)}<option value={r.country}>{r.name} ({r.country.toUpperCase()})</option>{/each}
              {#if !REGIONS.some((r) => r.country === country)}<option value={country}>{country.toUpperCase()}</option>{/if}
            </select>
          </div>
          <div class="field">
            <label for={`${id}-lang`}>{t('ckaLanguage')}</label>
            <input id={`${id}-lang`} name={`${id}-lang`} type="text" bind:value={language} autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="8"
              aria-invalid={formBad && !/^[a-z]{2}-[A-Z]{2}$/.test(language.trim()) ? 'true' : undefined} />
          </div>
        </div>
        {#if formBad}<p class="note warn" role="alert">{t('ckaForm')}</p>{/if}
        <div class="acts">
          <button type="submit" class="btn primary" disabled={busy}>{t('ckaSave')}</button>
          {#if editing}<button type="button" class="btn quiet-btn" onclick={() => { editing = false; formBad = false; error = ''; }} disabled={busy}>{t('cancel')}</button>{/if}
          {#if account.source === 'unreadable' && !editing}{@render removeUi()}{/if}
        </div>
      </form>
    {:else if account.source === 'stored' || account.source === 'unreadable'}
      <div class="acts">
        {#if account.source === 'stored'}
          <button type="button" class="btn" onclick={check} disabled={checking || busy || confirmRemove}>{checking ? t('ckaChecking') : t('ckaCheck')}</button>
          {#if canUse}<button type="button" class="btn" bind:this={changeBtn} onclick={edit} disabled={busy || confirmRemove}>{t('ckaChange')}</button>{/if}
        {/if}
        {@render removeUi()}
      </div>
    {:else if account.source === 'env'}
      <div class="acts"><button type="button" class="btn" onclick={check} disabled={checking}>{checking ? t('ckaChecking') : t('ckaCheck')}</button></div>
    {/if}

    {#if checkResult === 'ok'}<p class="note ok" role="status">{t('ckaOk')}</p>{/if}
    {#if error}<p class="note warn" role="alert">{error}</p>{/if}
    {#if account.error && !error}<p class="note warn">{t('admCookidooError', { reason: account.error })}</p>{/if}

    {#if account.key && !hideKey}<p class="note mono small">{t('ckaKey', { where: t(`ckaKey_${account.key}`) })}</p>{/if}
  {/if}
</div>

<style>
  .acct { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; background: var(--stone); border-radius: 20px 20px 20px 8px; padding: 12px 16px; font-size: 14px; min-width: 0; }
  .row strong { overflow-wrap: anywhere; }
  .row span { color: var(--quiet); }
  form { display: flex; flex-direction: column; gap: 12px; }
  .field input[type='email'], .field input[type='text'], .field select { background: var(--stone); }
  label { font-size: 13px; font-weight: 600; color: var(--quiet); }
  .two { display: grid; grid-template-columns: 1fr; gap: 12px; }
  .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .ask { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 14px; font-weight: 600; }
  .note.ok { color: var(--green-text); font-weight: 600; }
  .small { font-size: 11.5px; }
  @media (min-width: 520px) { .two { grid-template-columns: 1fr 1fr; } }
</style>
