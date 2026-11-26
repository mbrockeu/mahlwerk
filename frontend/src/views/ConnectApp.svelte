<script lang="ts">
  // "Sign in with the browser" for the iPhone app: the app opened /?connect_app=<challenge>&device=<name> in the system's sign-in
  // window. The person is signed in by now (proxy, passkey, password); here they confirm. Only then the server hands out a one-time
  // code, and the page goes to the app's fixed address (mahlwerk://connected), never to one from the link.
  import { api, ApiError } from '../lib/api';
  import { t } from '../lib/i18n';
  import { ui } from '../lib/store.svelte';

  let { challenge, device }: { challenge: string; device: string } = $props();
  const shown = $derived([...device.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, 60).join(''));
  const valid = $derived(/^[A-Za-z0-9_-]{43}$/.test(challenge) && shown.length > 0);
  let busy = $state(false);
  let error = $state('');
  let done = $state(false);

  async function allow() {
    busy = true; error = '';
    try {
      const { redirect } = await api.connectApp({ challenge, challenge_method: 'S256', device: shown });
      done = true;
      location.href = redirect;
    } catch (e) {
      error = t('appConFail', { error: e instanceof ApiError ? String(e.detail) : String(e) });
    } finally { busy = false; }
  }
  const cancel = () => { location.href = 'mahlwerk://connected?error=cancelled'; };
</script>

<main class="con-wrap">
  <section class="card con" aria-labelledby="con-app-title">
    {#if !valid}
      <h1 id="con-app-title">{t('appConTitle')}</h1>
      <p class="note warn" role="alert">{t('appConBad')}</p>
    {:else if done}
      <h1 id="con-app-title">{t('appConTitle')}</h1>
      <p role="status">{t('appConDone')}</p>
    {:else}
      <h1 id="con-app-title">{t('appConTitle')}</h1>
      <p class="quiet">{t('appConDevice', { device: shown })}<br>{t('appConAs', { name: ui.me?.display_name ?? '' })}</p>
      <p>{t('appConText')}</p>
      <p class="note warn">{t('appConWarn')}</p>
      {#if error}<p class="note warn" role="alert">{error}</p>{/if}
      <div class="row">
        <button class="btn primary" type="button" onclick={allow} disabled={busy}>{t('appConAllow')}</button>
        <button class="btn" type="button" onclick={cancel} disabled={busy}>{t('appConCancel')}</button>
      </div>
    {/if}
  </section>
</main>

<style>
  .con-wrap { min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: calc(22px + var(--safe-t)) 20px calc(26px + var(--safe-b)); }
  .con { width: 100%; max-width: 440px; display: flex; flex-direction: column; gap: 12px; }
  .con h1 { font-size: 1.6rem; margin: 0; }
  .con p { margin: 0; line-height: 1.5; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 6px; }
</style>
