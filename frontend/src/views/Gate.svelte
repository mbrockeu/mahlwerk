<script lang="ts">
  // The first page in the sign-in modes with a session: local (password form; first start: create the first admin) and
  // oidc (one button that leaves for the provider and comes back signed in).
  import { api, ApiError } from '../lib/api';
  import { nameValid, normalizeName, passwordProblem, waitText } from '../lib/account';
  import { t } from '../lib/i18n';
  import { auth, signedIn } from '../lib/store.svelte';

  const setup = $derived(auth.setup);
  const oidc = $derived(auth.mode === 'oidc');
  // after a failed sign-in the server sends the browser back with ?auth_error=<word>; show it once and clean the address
  const OIDC_ERRORS = ['denied', 'failed', 'expired', 'blocked', 'conflict', 'exists', 'name'] as const;
  const oidcError = (() => {
    const word = new URLSearchParams(location.search).get('auth_error') ?? '';
    return OIDC_ERRORS.find((w) => w === word) ?? null;
  })();
  if (new URLSearchParams(location.search).has('auth_error')) {
    const url = new URL(location.href);
    url.searchParams.delete('auth_error');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  let username = $state('');
  let display = $state('');
  let password = $state('');
  let repeat = $state('');
  let code = $state('');
  let reveal = $state(false);
  let busy = $state(false);
  let error = $state('');
  let field = $state<'' | 'user' | 'password' | 'repeat' | 'code'>('');

  // 48 ticks, two thirds filled: the grinder dial of the app, standing still
  const TICKS = 48;
  const R = 86;
  const STEP = (2 * Math.PI * R) / TICKS;
  const FILLED = 32;
  const fillLength = FILLED * STEP - 4.1;
  const angle = -Math.PI / 2 + (2 * Math.PI * FILLED) / TICKS;
  const px = 100 + R * Math.cos(angle);
  const py = 100 + R * Math.sin(angle);

  function problem(): string {
    field = '';
    if (!username.trim()) { field = 'user'; return t('authNeedName'); }
    if (setup && !nameValid(username)) { field = 'user'; return t('authNameBad'); }
    if (!password) { field = 'password'; return t('authNeedPassword'); }
    if (setup) {
      const bad = passwordProblem(password);
      if (bad) { field = 'password'; return bad === 'short' ? t('authShort') : t('authLong'); }
      if (password !== repeat) { field = 'repeat'; return t('authMismatch'); }
      if (auth.codeRequired && !code.trim()) { field = 'code'; return t('authNeedCode'); }
    }
    return '';
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    error = problem();
    if (error) return;
    busy = true;
    try {
      const name = normalizeName(username);
      const account = setup
        ? await api.setup({ username: name, display_name: display.trim(), password, ...(auth.codeRequired ? { setup_code: code.trim() } : {}) })
        : await api.login({ username: name, password });
      password = repeat = '';
      await signedIn(account);
    } catch (err) {
      password = repeat = '';
      if (err instanceof ApiError && err.status === 429) error = t('authWait', { time: waitText(err.retryAfter ?? 60) });
      else if (err instanceof ApiError && err.status === 401) { error = t('authBad'); field = 'password'; }
      else if (err instanceof ApiError && err.status === 403) { error = setup ? t('authCodeWrong') : t('authBlocked'); field = 'code'; }
      else if (err instanceof ApiError && err.status === 409 && setup) { error = t('authAlready'); auth.setup = false; }
      else error = t('authFailed', { reason: err instanceof ApiError ? (typeof err.detail === 'string' ? err.detail : err.status || err.message) : 'error' });
    } finally {
      busy = false;
    }
  }
</script>

<main class="gate-wrap">
  <div class="gate">
    <section class="hero" aria-labelledby="gate-title">
      <svg class="dial" viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <mask id="gate-mask"><circle cx="100" cy="100" r={R} fill="none" stroke="#fff" stroke-width="24" stroke-dasharray="{fillLength} 541" transform="rotate(-90 100 100)" /></mask>
        </defs>
        <circle cx="100" cy="100" r={R} fill="none" stroke="#4d8a70" stroke-width="18" stroke-dasharray="3 {STEP - 3}" transform="rotate(-90 100 100)" />
        <circle cx="100" cy="100" r={R} fill="none" stroke="#c9f04a" stroke-width="18" stroke-dasharray="3 {STEP - 3}" transform="rotate(-90 100 100)" mask="url(#gate-mask)" />
        <circle cx={px} cy={py} r="9" fill="#ff8a1f" />
      </svg>
      <p class="micro brand">{t('appName')}</p>
      <h1 id="gate-title" class="display">{setup ? t('authSetupTitle') : t('authLoginTitle')}</h1>
      <p class="lead">{setup ? t('authSetupLead') : t('authLoginLead')}</p>
    </section>

    {#if oidc}
      <div class="card" aria-labelledby="gate-title">
        {#if oidcError}<p class="note warn" role="alert">{t(`oidcErr_${oidcError}`)}</p>
        {:else if auth.ended}<p class="note ended" role="status">{t('authEnded')}</p>{/if}
        <!-- a plain link, not fetch: the browser has to leave for the provider and come back with its cookie -->
        <a class="btn primary go" href="api/v1/auth/oidc/login" rel="nofollow">{auth.oidcLabel ? t('oidcSignInWith', { name: auth.oidcLabel }) : t('oidcSignIn')}</a>
        <p class="note">{t('oidcNote')}</p>
      </div>
    {:else}
    <form class="card" onsubmit={submit} novalidate aria-labelledby="gate-title">
      {#if auth.ended && !setup && !error}<p class="note ended" role="status">{t('authEnded')}</p>{/if}

      <div class="field">
        <label for="gate-user">{t('authUser')}</label>
        <input id="gate-user" type="text" bind:value={username} autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"
          maxlength="200" aria-invalid={field === 'user'} />
      </div>

      {#if setup}
        <div class="field">
          <label for="gate-display">{t('authDisplay')}</label>
          <input id="gate-display" type="text" bind:value={display} autocomplete="name" maxlength="80" />
        </div>
      {/if}

      <div class="field">
        <label for="gate-pw">{setup ? t('authPasswordNew') : t('authPassword')}</label>
        <div class="pw">
          <input id="gate-pw" type={reveal ? 'text' : 'password'} bind:value={password} autocomplete={setup ? 'new-password' : 'current-password'}
            autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="300" aria-invalid={field === 'password'} aria-describedby={setup ? 'gate-rule' : undefined} />
          <button type="button" class="show" aria-pressed={reveal} onclick={() => (reveal = !reveal)}>{reveal ? t('authHide') : t('authShow')}</button>
        </div>
        {#if setup}<p id="gate-rule" class="note">{t('authRule')}</p>{/if}
      </div>

      {#if setup}
        <div class="field">
          <label for="gate-repeat">{t('authRepeat')}</label>
          <input id="gate-repeat" type={reveal ? 'text' : 'password'} bind:value={repeat} autocomplete="new-password" autocapitalize="none" autocorrect="off"
            spellcheck="false" maxlength="300" aria-invalid={field === 'repeat'} />
        </div>
      {/if}

      {#if setup && auth.codeRequired}
        <div class="field">
          <label for="gate-code">{t('authCode')}</label>
          <input id="gate-code" type="text" bind:value={code} autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"
            maxlength="200" aria-invalid={field === 'code'} aria-describedby="gate-code-hint" />
          <p id="gate-code-hint" class="note">{t('authCodeHint')}</p>
        </div>
      {/if}

      {#if error}<p class="note warn" role="alert">{error}</p>{/if}

      <button class="btn primary go" type="submit" disabled={busy}>{busy ? t('authBusy') : setup ? t('authCreate') : t('authLogin')}</button>
    </form>
    {/if}
  </div>
</main>

<style>
  .gate-wrap { min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: calc(22px + var(--safe-t)) 20px calc(26px + var(--safe-b)); }
  .gate { width: 100%; max-width: 440px; display: flex; flex-direction: column; gap: 12px; }
  .hero {
    position: relative; overflow: hidden; background: var(--green); color: #fff; border-radius: 44px 44px 44px 14px;
    padding: 24px 24px 26px; display: flex; flex-direction: column; gap: 6px; min-height: 190px; --focus: var(--lime);
  }
  .dial { position: absolute; width: 100px; height: 100px; right: 18px; top: 16px; }
  .brand { color: var(--lime); }
  h1 { font-size: clamp(38px, 11vw, 52px); line-height: 0.95; margin-top: 58px; }
  .lead { color: #d5ead0; font-size: 15px; max-width: 30ch; line-height: 1.35; }
  .card { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 20px 18px 18px; display: flex; flex-direction: column; gap: 14px; }
  .field label { font-size: 13px; font-weight: 600; color: var(--quiet); }
  .card .field input { background: var(--stone); }
  .pw { position: relative; display: flex; }
  .pw input { padding-right: 84px; }
  .show {
    position: absolute; right: 4px; top: 4px; bottom: 4px; min-width: 64px; padding: 0 12px; border-radius: 12px 12px 12px 5px; font-family: var(--f-mono);
    font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; background: var(--paper); color: var(--text); border: 2px solid var(--hairline);
  }
  .ended { color: var(--text); background: var(--stone); border-radius: 14px 14px 14px 5px; padding: 10px 12px; }
  .go { min-height: 52px; width: 100%; font-size: 16px; display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }

  @media (min-width: 900px) {
    main.gate-wrap { padding-left: 20px; } /* no navigation rail here */
    .gate { max-width: 860px; flex-direction: row; align-items: stretch; gap: 14px; }
    .hero { flex: 1 1 0; min-height: 420px; padding: 32px 32px 34px; justify-content: flex-end; }
    .dial { width: 220px; height: 220px; right: 30px; top: 30px; }
    h1 { font-size: 64px; margin-top: 0; }
    .card { flex: 1 1 0; justify-content: center; padding: 28px 26px 26px; }
  }
</style>
