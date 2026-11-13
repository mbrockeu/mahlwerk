<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { api, ApiError } from '../lib/api';
  import { clock, fromLocalInput, hoursMinutes, pad, toLocalInput } from '../lib/date';
  import { fmt, t } from '../lib/i18n';
  import { Tweened, easeOut } from '../lib/motion.svelte';
  import { toast } from '../lib/store.svelte';
  import type { Fast, Fasting } from '../lib/types';

  // Intervall fasting: a small dial of ticks while a fast runs, a slim row otherwise. The time is calculated in the
  // browser from `started_at`, so no polling is needed; coming back to the app reloads the state.
  let fasting = $state<Fasting | null>(null);
  let now = $state(Date.now());
  let busy = $state(false);
  let editing = $state(false);
  let from = $state('');
  let to = $state('');
  let error = $state('');
  let confirmDelete = $state(false);

  const uid = $props.id();
  const TICKS = 36;
  const R = 41;
  const STEP = (2 * Math.PI * R) / TICKS;
  const intro = new Tweened();

  async function load() {
    try { fasting = await api.fasting(); } catch { /* the card stays as it is */ }
  }
  onMount(() => {
    void load();
    const visible = () => { if (document.visibilityState === 'visible') { now = Date.now(); void load(); } };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  });

  const current = $derived(fasting?.current ?? null);
  const last = $derived(fasting?.last ?? null);
  $effect(() => {
    if (!current) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  $effect(() => { const on = !!current; untrack(() => { if (on) intro.to(1, 700, easeOut, 0); }); });

  const elapsed = $derived(current ? Math.max(0, now / 1000 - current.started_at) : 0);
  const goalSeconds = $derived(current ? current.target_hours * 3600 : 1);
  const reached = $derived(!!current && elapsed >= goalSeconds);
  const progress = $derived(Math.min(1, elapsed / goalSeconds) * intro.value);
  const filled = $derived(Math.max(0, Math.min(TICKS, Math.floor(progress * TICKS + 0.0001))));
  const maskLength = $derived(filled === 0 ? 0 : filled * STEP - 2.2);
  const angle = $derived(-Math.PI / 2 + 2 * Math.PI * progress);
  const px = $derived(50 + R * Math.cos(angle));
  const py = $derived(50 + R * Math.sin(angle));
  const hm = $derived(hoursMinutes(elapsed));
  const seconds = $derived(pad(Math.floor(elapsed) % 60));
  const goalText = $derived(current ? fmt(current.target_hours, 1) : '');
  const reason = (err: unknown) => (err instanceof ApiError ? err.status || err.message : 'error');

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    try { await action(); await load(); } catch (err) { toast(t('fastFailed', { reason: reason(err) })); await load(); } finally { busy = false; }
  }
  const start = () => run(() => api.startFast());
  const stop = () => run(() => api.stopFast());

  function openEdit(fast: Fast) {
    from = toLocalInput(fast.started_at);
    to = fast.ended_at ? toLocalInput(fast.ended_at) : '';
    error = '';
    confirmDelete = false;
    editing = true;
  }
  async function save(event: SubmitEvent, fast: Fast) {
    event.preventDefault();
    const started = fromLocalInput(from);
    const ended = fast.ended_at ? fromLocalInput(to) : null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Number.isNaN(started) || started > nowSec + 60 || (ended != null && (Number.isNaN(ended) || ended < started || ended > nowSec + 60))) {
      error = t('fastBadTime');
      return;
    }
    const body: { started_at?: number; ended_at?: number } = {};
    if (started !== fast.started_at) body.started_at = started;
    if (ended != null && ended !== fast.ended_at) body.ended_at = ended;
    if (Object.keys(body).length === 0) { editing = false; return; }
    busy = true;
    try {
      await api.patchFast(fast.id, body);
      editing = false;
      toast(t('fastSaved'));
      await load();
    } catch (err) {
      error = t('fastFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }
  async function remove(fast: Fast) {
    if (!confirmDelete) { confirmDelete = true; return; }
    busy = true;
    try {
      await api.deleteFast(fast.id);
      editing = false;
      toast(t('fastDeleted'));
      await load();
    } catch (err) {
      error = t('fastFailed', { reason: reason(err) });
    } finally {
      busy = false;
    }
  }
</script>

{#snippet editor(fast: Fast)}
  <form class="edit" onsubmit={(e) => save(e, fast)}>
    <label class="field"><span>{t('fastFromLabel')}</span>
      <input type="datetime-local" bind:value={from} aria-invalid={error ? 'true' : undefined} /></label>
    {#if fast.ended_at}
      <label class="field"><span>{t('fastToLabel')}</span>
        <input type="datetime-local" bind:value={to} aria-invalid={error ? 'true' : undefined} /></label>
    {/if}
    {#if error}<p class="note warn" role="alert">{error}</p>{/if}
    <div class="editbtns">
      <button class="btn lime" disabled={busy}>{t('save')}</button>
      <button type="button" class="btn ghost" onclick={() => (editing = false)}>{t('cancel')}</button>
    </div>
    {#if fast.ended_at}
      <button type="button" class="del" onclick={() => remove(fast)} disabled={busy}>{confirmDelete ? t('fastConfirmDelete') : t('fastDelete')}</button>
    {/if}
  </form>
{/snippet}

{#if fasting}
  {#if current}
    <section class="fast on" class:reached aria-label={t('fastTitle')}>
      <div class="row">
        <div class="ring">
          <svg viewBox="0 0 100 100" role="img" aria-label={t('fastAria', { elapsed: hm, goal: goalText })}>
            <defs>
              <mask id="{uid}-m"><circle cx="50" cy="50" r={R} fill="none" stroke="#fff" stroke-width="14"
                stroke-dasharray="{maskLength} 400" transform="rotate(-90 50 50)" /></mask>
            </defs>
            <circle cx="50" cy="50" r={R} fill="none" stroke="var(--tick-off)" stroke-width="9" stroke-dasharray="2 {STEP - 2}" transform="rotate(-90 50 50)" />
            <circle cx="50" cy="50" r={R} fill="none" stroke="#c9f04a" stroke-width="9" stroke-dasharray="2 {STEP - 2}" transform="rotate(-90 50 50)" mask="url(#{uid}-m)" />
            <circle cx={px} cy={py} r="4.6" fill={reached ? 'var(--pink)' : 'var(--orange)'} stroke="var(--deep)" stroke-width="2" />
          </svg>
          <div class="center" aria-hidden="true">
            <span class="num">{hm}</span><span class="sec mono">{seconds} s</span>
          </div>
        </div>
        <div class="info">
          <span class="micro lab">{t('fastTitle')}</span>
          <span class="of mono" aria-live="off"><b>{hm}</b> {t('fastOf', { goal: goalText })}</span>
          <span class="times mono">{t('fastStarted', { time: clock(current.started_at, now / 1000) })}<br />{t('fastTargetAt', { time: clock(current.started_at + goalSeconds, now / 1000) })}</span>
        </div>
      </div>
      {#if reached}<p class="calm">{t('fastReached', { goal: goalText })}</p>{/if}
      <div class="acts">
        <button class="btn lime end" onclick={stop} disabled={busy}>{t('fastEnd')}</button>
        <button class="round edit-btn" onclick={() => (editing ? (editing = false) : openEdit(current))} aria-label={t('fastEdit')} aria-expanded={editing}><Icon name="edit" size={20} /></button>
      </div>
      {#if editing}{@render editor(current)}{/if}
    </section>
  {:else}
    <section class="fast idle" aria-label={t('fastTitle')}>
      <div class="rowline">
        <button class="start" onclick={start} disabled={busy}>
          <span class="t"><strong>{t('fastStart')}</strong><small>{last?.duration_seconds != null ? t('fastLast', { h: hoursMinutes(last.duration_seconds) }) : t('fastNone')}</small></span>
          <span class="go" aria-hidden="true"><Icon name="clock" size={22} stroke={2.4} /></span>
        </button>
        {#if last}
          <button class="round edit-btn" onclick={() => (editing ? (editing = false) : openEdit(last))} aria-label={t('fastEditLast')} aria-expanded={editing}><Icon name="edit" size={20} /></button>
        {/if}
      </div>
      {#if editing && last}{@render editor(last)}{/if}
    </section>
  {/if}
{/if}

<style>
  .fast.on { background: var(--deep); color: var(--on-deep); border-radius: 28px 28px 28px 8px; padding: 16px 16px 14px 16px; display: flex; flex-direction: column; gap: 12px; --focus: var(--lime); min-width: 0; }
  .row { display: flex; align-items: center; gap: 16px; }
  .ring { position: relative; width: 116px; height: 116px; flex-shrink: 0; }
  .ring svg { width: 100%; height: 100%; display: block; }
  .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
  .num { font-family: var(--f-display); font-weight: 800; font-size: 21px; letter-spacing: -0.04em; line-height: 1; }
  .sec { font-size: 11px; font-weight: 500; color: #b9c7bd; }
  .info { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .lab { color: #b9c7bd; }
  .of { font-size: 15px; font-weight: 500; color: #dfe6dc; }
  .of b { font-size: 21px; font-weight: 600; color: #fff; }
  .times { font-size: 12.5px; line-height: 1.55; color: #b9c7bd; }
  .calm { font-size: 14px; line-height: 1.35; color: var(--pink); }
  .acts { display: flex; gap: 8px; align-items: center; }
  .end { flex: 1; }
  .edit-btn { background: transparent; border: 2px solid var(--deep-line); color: var(--on-deep); }
  .idle .edit-btn { border-color: var(--hairline); color: var(--text); background: var(--paper); }
  .btn.ghost { background: transparent; border-color: var(--deep-line); color: var(--on-deep); }

  .edit { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--deep-line); padding-top: 12px; }
  .idle .edit { border-top-color: var(--hairline); padding: 0 6px 6px; }
  .edit .field > span { color: #b9c7bd; }
  .idle .edit .field > span { color: var(--quiet); }
  .edit input { background: var(--paper); color: var(--text); }
  .idle .edit input { background: var(--stone); }
  .editbtns { display: flex; gap: 8px; }
  .editbtns .btn { flex: 1; }
  .idle .btn.ghost { color: var(--text); border-color: var(--hairline); }
  .del { align-self: flex-start; min-height: 44px; padding: 0 4px; font-size: 14px; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; color: var(--pink); }
  .idle .del { color: var(--warn); }

  .idle { background: var(--paper); border-radius: 20px; min-width: 0; }
  .rowline { display: flex; align-items: center; gap: 4px; padding-right: 4px; }
  .start { flex: 1; min-width: 0; min-height: 56px; padding: 6px 8px 6px 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; }
  .t { display: flex; flex-direction: column; min-width: 0; }
  .t strong { font-size: 15px; font-weight: 600; line-height: 1.2; }
  .t small { font-size: 12px; color: var(--quiet); font-family: var(--f-mono); }
  .go { width: 40px; height: 40px; border-radius: 20px; background: var(--deep); color: var(--lime); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .start[disabled] { opacity: 0.6; }
</style>
