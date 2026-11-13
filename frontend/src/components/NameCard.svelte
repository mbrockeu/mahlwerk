<script lang="ts">
  // The head of "Profile and goals": avatar, display name, user name and where the sign-in comes from. The display name can
  // be changed (and reset to the one from the sign-in); the user name never changes.
  import { tick } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { NAME_MAX, cleanDisplayName, initialOf, nameProblem } from '../lib/account';
  import { t } from '../lib/i18n';
  import { auth, toast, ui } from '../lib/store.svelte';

  let editing = $state(false);
  let value = $state('');
  let busy = $state(false);
  let error = $state('');
  let input: HTMLInputElement | undefined = $state();
  let opener: HTMLButtonElement | undefined = $state();

  const me = $derived(ui.me);
  const name = $derived(me?.display_name || me?.username || '');
  const custom = $derived(me?.display_name_custom === true);
  const fromProvider = $derived(me?.provider_name || '');
  const problem = $derived(nameProblem(value));
  const origin = $derived(
    auth.mode === 'local' ? t('nameViaLocal')
    : auth.mode === 'oidc' ? (auth.oidcLabel ? t('nameViaOidc', { name: auth.oidcLabel }) : t('nameViaOidcPlain'))
    : auth.mode === 'proxy' ? t('nameViaProxy') : '',
  );

  async function edit() {
    value = name;
    error = '';
    editing = true;
    await tick();
    input?.focus();
    input?.select();
  }
  async function stop() {
    editing = false;
    error = '';
    await tick();
    opener?.focus();
  }
  const message = (p: NonNullable<typeof problem>) => (p === 'empty' ? t('nameEmpty') : p === 'long' ? t('nameLong') : t('nameBad'));

  async function send(next: string | null, done: string) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      ui.me = await api.setDisplayName(next);
      toast(done);
      await stop();
    } catch (err) {
      error = err instanceof ApiError && err.status === 422 ? t('nameBad') : t('saveFailed', { reason: err instanceof ApiError ? err.status || err.message : 'error' });
    } finally {
      busy = false;
    }
  }
  function save(e: SubmitEvent) {
    e.preventDefault();
    if (problem) { error = message(problem); return; }
    const clean = cleanDisplayName(value);
    if (clean === name) { void stop(); return; }
    void send(clean, t('nameSaved'));
  }
  const reset = () => send(null, t('nameWasReset'));
  function key(e: KeyboardEvent) { if (e.key === 'Escape') { e.stopPropagation(); void stop(); } }
</script>

{#if me}
  <section class="who" aria-labelledby="who-name">
    <span class="av display" aria-hidden="true">{initialOf(name, '?')}</span>
    <div class="txt">
      {#if editing}
        <form onsubmit={save} novalidate>
          <label for="who-input" class="micro quiet">{t('nameEditing')}</label>
          <input id="who-input" bind:this={input} bind:value onkeydown={key} maxlength={NAME_MAX * 2} autocomplete="nickname" autocapitalize="words"
            aria-invalid={error ? 'true' : undefined} aria-describedby="who-note" />
          <p id="who-note" class="note" class:warn={!!error} role={error ? 'alert' : undefined}>
            {error || (fromProvider && !custom ? t('nameHint', { user: me.username }) : t('nameHintOwn', { user: me.username }))}
          </p>
          {#if custom && fromProvider}<p class="note">{t('nameFrom', { name: fromProvider })}</p>{/if}
          <div class="acts">
            <button type="submit" class="btn primary" disabled={busy}>{t('save')}</button>
            <button type="button" class="btn" onclick={stop} disabled={busy}>{t('cancel')}</button>
            {#if custom}
              <button type="button" class="btn quiet-btn" onclick={reset} disabled={busy} aria-label={fromProvider ? t('nameResetTo', { name: fromProvider }) : t('nameReset')}>{t('nameReset')}</button>
            {/if}
          </div>
        </form>
      {:else}
        <h2 id="who-name" class="display nm">{name}</h2>
        <p class="sub mono">{t('nameUser', { user: me.username })}{#if origin}{' · '}{origin}{/if}</p>
        <button type="button" class="btn change" bind:this={opener} onclick={edit}>{t('nameChange')}</button>
      {/if}
    </div>
  </section>
{/if}

<style>
  .who { display: flex; align-items: flex-start; gap: 16px; background: var(--paper); border-radius: 36px 36px 36px 12px; padding: 18px 20px 18px 18px; min-width: 0; }
  .av { flex: none; width: 64px; height: 64px; border-radius: 50%; background: var(--deep); color: var(--on-deep); display: grid; place-items: center; font-size: 30px; line-height: 1; }
  .txt { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .nm { font-size: 32px; line-height: 1.05; letter-spacing: -0.03em; overflow-wrap: anywhere; min-width: 0; max-width: 100%; margin: 0; }
  .sub { font-size: 12px; color: var(--quiet); overflow-wrap: anywhere; }
  .change { min-height: 44px; margin-top: 4px; }
  form { display: flex; flex-direction: column; gap: 8px; width: 100%; align-items: stretch; }
  input { min-height: 48px; padding: 0 16px; border-radius: 24px 24px 24px 8px; background: var(--stone); border: 2px solid var(--hairline); font-size: 18px; font-weight: 600; width: 100%; min-width: 0; }
  input:focus-visible { outline-offset: 0; border-color: var(--focus-base); }
  input[aria-invalid='true'] { border-color: var(--warn); }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .acts .btn { min-height: 44px; }
  @media (min-width: 900px) {
    .who { padding: 22px 30px 22px 24px; gap: 22px; }
    .av { width: 84px; height: 84px; font-size: 40px; }
    .nm { font-size: 44px; }
    form { max-width: 520px; }
  }
</style>
