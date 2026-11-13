<script lang="ts">
  // Profile card "Webhooks": add and edit targets, pick events, send a test, see the last deliveries.
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { fmtDate, t } from '../lib/i18n';
  import { toast } from '../lib/store.svelte';
  import { WEBHOOK_EVENTS, type Webhook, type WebhookDelivery, type WebhookEvent } from '../lib/types';
  import Icon from './Icon.svelte';
  import Toggle from './Toggle.svelte';

  let hooks = $state<Webhook[]>([]);
  let loaded = $state(false);
  /** null: no form; 0: new webhook; else the id being edited. */
  let editing = $state<number | null>(null);
  let name = $state('');
  let url = $state('');
  let events = $state<WebhookEvent[]>([]);
  let enabled = $state(true);
  let urlBad = $state('');
  let eventsBad = $state(false);
  let busy = $state(false);
  let error = $state('');
  let secret = $state<string | null>(null);
  let copied = $state(false);
  let copyFailed = $state(false);
  let secretEl = $state<HTMLElement>();
  let open = $state<number | null>(null);
  let deliveries = $state<WebhookDelivery[]>([]);
  let confirm = $state<number | null>(null);
  let timers: number[] = [];

  const reason = (err: unknown) => (err instanceof ApiError ? (typeof err.detail === 'string' ? err.detail : err.status || err.message) : 'error');
  const load = async () => { try { hooks = await api.webhooks(); } catch { hooks = []; } loaded = true; };
  onMount(() => { void load(); return () => timers.forEach(clearTimeout); });

  function startForm(hook?: Webhook) {
    editing = hook ? hook.id : 0;
    name = hook?.name ?? '';
    url = hook?.url ?? '';
    events = hook ? [...hook.events] : ['entry.created'];
    enabled = hook?.enabled ?? true;
    urlBad = '';
    eventsBad = false;
    error = '';
    secret = null;
  }
  const toggleEvent = (ev: WebhookEvent) => { events = events.includes(ev) ? events.filter((x) => x !== ev) : [...events, ev]; eventsBad = false; };

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    urlBad = /^https?:\/\/[^\s/]+/i.test(url.trim()) ? '' : t('whBadUrl');
    eventsBad = events.length === 0;
    if (!name.trim()) name = new URL(url.trim().match(/^https?:\/\//i) ? url.trim() : 'http://x').hostname;
    if (urlBad || eventsBad) return;
    busy = true;
    error = '';
    try {
      const ordered = WEBHOOK_EVENTS.filter((x) => events.includes(x));
      if (editing === 0) {
        const made = await api.createWebhook({ name: name.trim(), url: url.trim(), events: ordered, enabled });
        secret = made.secret;
        copied = copyFailed = false;
      } else if (editing != null) {
        await api.patchWebhook(editing, { name: name.trim(), url: url.trim(), events: ordered, enabled });
        toast(t('whSaved'));
      }
      editing = null;
      await load();
    } catch (err) {
      error = t('saveFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }

  async function copy() {
    if (secret == null) return;
    try { await navigator.clipboard.writeText(secret); copied = true; copyFailed = false; } catch {
      copyFailed = true;
      if (secretEl) { const r = document.createRange(); r.selectNodeContents(secretEl); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); }
    }
  }

  async function setActive(h: Webhook) {
    try { await api.patchWebhook(h.id, { enabled: !h.enabled }); await load(); } catch (err) { error = t('saveFailed', { reason: reason(err) }); }
  }

  async function remove(id: number) {
    if (confirm !== id) { confirm = id; return; }
    busy = true;
    try {
      await api.deleteWebhook(id);
      confirm = null;
      if (open === id) open = null;
      toast(t('whDeleted'));
      await load();
    } catch (err) {
      error = t('saveFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }

  async function loadDeliveries(id: number) {
    try { deliveries = await api.webhookDeliveries(id); } catch { deliveries = []; }
  }
  async function showDeliveries(id: number) {
    if (open === id) { open = null; return; }
    open = id;
    deliveries = [];
    await loadDeliveries(id);
  }
  async function test(id: number) {
    error = '';
    try {
      await api.testWebhook(id);
      toast(t('whTestQueued'));
      open = id;
      // the delivery happens in the background: look again a moment later
      for (const ms of [700, 2500, 7000]) timers.push(window.setTimeout(() => { if (open === id) void loadDeliveries(id); }, ms));
      await loadDeliveries(id);
    } catch (err) {
      error = t('saveFailed', { reason: reason(err) });
    }
  }

  const tries = (n: number) => (n === 1 ? t('whTry') : t('whTries', { n }));
  const okOf = (d: WebhookDelivery) => d.finished_at != null && d.status_code != null && d.status_code >= 200 && d.status_code < 300 && !d.error;
  const stamp = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const evName = (ev: string) => t(`ev_${ev}`);
</script>

<section class="icard" aria-labelledby="wh-title">
  <h2 id="wh-title" class="micro quiet">{t('whTitle')}</h2>
  <p class="note">{t('whText')}</p>

  {#if secret}
    <div class="reveal" role="group" aria-labelledby="wh-sec">
      <span id="wh-sec" class="micro">{t('whSecretTitle')}</span>
      <div class="secret" bind:this={secretEl} data-testid="webhook-secret">{secret}</div>
      <p><strong>{t('whSecretOnce')}</strong></p>
      <div class="acts">
        <button type="button" onclick={copy}><Icon name={copied ? 'check' : 'copy'} size={18} stroke={2.4} />{copied ? t('tokCopied') : t('tokCopy')}</button>
        <button type="button" class="ghost" onclick={() => (secret = null)}>{t('tokDone')}</button>
      </div>
      {#if copyFailed}<p role="alert">{t('tokCopyFailed')}</p>{/if}
    </div>
  {/if}

  {#if editing != null}
    <form onsubmit={submit} novalidate>
      <div class="field">
        <span id="wh-name-l">{t('whName')}</span>
        <input type="text" aria-labelledby="wh-name-l" placeholder={t('whNamePh')} maxlength="80" autocomplete="off" bind:value={name} />
      </div>
      <div class="field">
        <span id="wh-url-l">{t('whUrl')}</span>
        <input type="url" aria-labelledby="wh-url-l" placeholder="https://…" maxlength="500" autocomplete="off" autocapitalize="none" spellcheck="false" bind:value={url} aria-invalid={!!urlBad} />
        {#if urlBad}<p class="note warn" role="alert">{urlBad}</p>{/if}
      </div>
      <fieldset class="field evs">
        <legend>{t('whEvents')}</legend>
        <div class="checks">
          {#each WEBHOOK_EVENTS as ev}
            <label class="check"><input type="checkbox" checked={events.includes(ev)} onchange={() => toggleEvent(ev)} /><span>{evName(ev)} <span class="mono code">{ev}</span></span></label>
          {/each}
        </div>
        {#if eventsBad}<p class="note warn" role="alert">{t('whPickEvent')}</p>{/if}
      </fieldset>
      <Toggle checked={enabled} label={t('whActive')} sub={enabled ? t('admOn') : t('admOff')} onchange={() => (enabled = !enabled)} />
      <div class="chips">
        <button class="btn primary" type="submit" disabled={busy}>{t('save')}</button>
        <button class="btn" type="button" onclick={() => (editing = null)}>{t('cancel')}</button>
      </div>
    </form>
  {:else}
    <div class="chips"><button class="btn primary" type="button" onclick={() => startForm()}>{t('whAdd')}</button></div>
  {/if}
  {#if error}<p class="note warn" role="alert">{error}</p>{/if}

  {#if loaded && hooks.length === 0}
    <p class="note">{t('whNone')}</p>
  {:else if hooks.length}
    <ul class="hooks" aria-label={t('whTitle')}>
      {#each hooks as h (h.id)}
        <li class="hook" class:off={!h.enabled}>
          <div class="head">
            <span class="t">
              <strong>{h.name}</strong>
              <small class="mono url">{h.url}</small>
              <small>{t('whEventsN', { n: h.events.length })}{h.enabled ? '' : ` · ${t('admOff')}`}</small>
            </span>
          </div>
          <div class="chips">
            <button type="button" class="btn small" onclick={() => test(h.id)}>{t('whTest')}</button>
            <button type="button" class="btn small" aria-expanded={open === h.id} onclick={() => showDeliveries(h.id)}>{t('whDeliveries')}</button>
            <button type="button" class="btn small" onclick={() => startForm(h)}>{t('whEdit')}</button>
            <button type="button" class="btn small" role="switch" aria-checked={h.enabled} onclick={() => setActive(h)}>{t('whActive')}: {h.enabled ? t('admOn') : t('admOff')}</button>
            <button type="button" class="btn danger small" disabled={busy} onclick={() => remove(h.id)}>{confirm === h.id ? t('whDeleteConfirm') : t('whDelete')}</button>
            {#if confirm === h.id}<button type="button" class="btn quiet-btn small" onclick={() => (confirm = null)}>{t('cancel')}</button>{/if}
          </div>
          {#if open === h.id}
            <div class="deliv">
              <h3 class="micro quiet">{t('whDeliveries')}</h3>
              {#if deliveries.length === 0}
                <p class="note">{t('whNoDeliveries')}</p>
              {:else}
                <ul>
                  {#each deliveries as d (d.id)}
                    <li>
                      <span class="pill-state" class:ok={okOf(d)} class:bad={d.finished_at != null && !okOf(d)}>{d.finished_at == null ? t('whPending') : okOf(d) ? t('whOk') : t('whFailed')}</span>
                      <span class="what">{evName(d.event)}</span>
                      <span class="mono meta">{stamp(d.created_at)} · {d.status_code ?? '–'}{d.error && !okOf(d) ? ` · ${d.error}` : ''} · {tries(d.attempts)}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  form { display: flex; flex-direction: column; gap: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .evs { border: 0; padding: 0; margin: 0; min-width: 0; }
  .evs legend { font-size: 13px; font-weight: 600; color: var(--quiet); padding: 0 0 6px; }
  .code { font-size: 11px; color: var(--quiet); display: block; }
  .hooks { display: flex; flex-direction: column; gap: 8px; }
  .hook { background: var(--stone); border-radius: 20px 20px 20px 8px; padding: 12px 14px 12px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .hook.off .head { opacity: 0.65; }
  .t { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
  .t strong { font-size: 15px; font-weight: 600; }
  .t small { font-size: 12px; color: var(--quiet); }
  .url { word-break: break-all; }
  .hook .btn { background: var(--paper); }
  .hook .btn.danger { background: transparent; }
  .hook .btn.quiet-btn { background: transparent; }
  .deliv { display: flex; flex-direction: column; gap: 8px; }
  .deliv ul { display: flex; flex-direction: column; gap: 6px; }
  .deliv li { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: center; background: var(--paper); border-radius: 14px 14px 14px 6px; padding: 8px 12px; }
  .what { font-size: 14px; font-weight: 600; }
  .meta { grid-column: 1 / -1; font-size: 11.5px; color: var(--quiet); word-break: break-word; }
</style>
