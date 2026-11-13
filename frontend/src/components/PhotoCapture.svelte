<script lang="ts">
  import { onDestroy } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { lang, t } from '../lib/i18n';
  import { failure, markNoticeSeen, noticeSeen, NothingFound, waitText, type VisionFailure } from '../lib/vision';
  import type { VisionMeal, VisionRecipe } from '../lib/types';
  import Icon from './Icon.svelte';
  import PhotoActions from './PhotoActions.svelte';

  // The capture step of photo recognition (meal or recipe): the one-time privacy notice, the photo (camera or library, shrunk in the browser), a
  // waiting state the person can cancel, and the failures in plain words with "Try again". The owner decides what happens with the answer: `onresult`
  // may take its time (the meal screen matches the foods there), the waiting state stays until it is done; it throws `NothingFound` for an empty answer.
  let { kind, onresult }:
    { kind: 'meal' | 'recipe'; onresult: (result: VisionMeal | VisionRecipe) => void | Promise<void> } = $props();

  let step = $state<'notice' | 'ready' | 'waiting' | 'problem'>(noticeSeen() ? 'ready' : 'notice');
  let problem = $state<VisionFailure | 'nothing' | null>(null);
  let preview = $state('');
  let last: Blob | null = null;
  let remaining = $state(0);
  let controller: AbortController | null = null;
  let run = 0;
  let countdown = 0;

  const release = () => { if (preview) URL.revokeObjectURL(preview); preview = ''; };
  onDestroy(() => { run += 1; controller?.abort(); clearInterval(countdown); release(); });

  function understood() { markNoticeSeen(); step = 'ready'; }

  async function send(image: Blob) {
    const mine = ++run;
    last = image;
    release();
    preview = URL.createObjectURL(image);
    step = 'waiting';
    controller = new AbortController();
    try {
      const result = kind === 'meal' ? await api.visionMeal(image, lang, controller.signal) : await api.visionRecipe(image, lang, controller.signal);
      if (mine !== run) return;
      const empty = kind === 'meal' ? (result as VisionMeal).items.length === 0 : (result as VisionRecipe).ingredients.length === 0;
      if (empty) throw new NothingFound();
      await onresult(result);
    } catch (err) {
      if (mine !== run) return; // cancelled (or the sheet is gone)
      if (err instanceof NothingFound) problem = 'nothing';
      else {
        const status = err instanceof ApiError ? err.status : 0;
        problem = failure(status, err instanceof ApiError ? err.retryAfter : null, typeof navigator === 'undefined' || navigator.onLine !== false);
      }
      step = 'problem';
      startCountdown();
    }
  }

  function startCountdown() {
    clearInterval(countdown);
    remaining = typeof problem === 'object' && problem ? problem.wait : 0;
    if (remaining > 0) countdown = window.setInterval(() => { remaining -= 1; if (remaining <= 0) clearInterval(countdown); }, 1000);
  }

  function cancel() {
    run += 1;
    controller?.abort();
    step = 'ready';
  }
  const again = () => { if (last && remaining <= 0) void send(last); };
  const another = () => { clearInterval(countdown); release(); last = null; step = 'ready'; };

  const text = (p: VisionFailure | 'nothing') => {
    if (p === 'nothing') return t(kind === 'meal' ? 'visNothingMeal' : 'visNothingRecipe');
    const w = waitText(p.wait);
    return t(`visErr_${p.code}`, { n: w.n, unit: w.unit === 's' ? t('visSec') : t('visMin') });
  };
  // a request that failed for a reason a second try cannot change has no "Try again"
  const retryable = $derived(problem !== null && problem !== 'nothing' && !['toolarge', 'unreadable', 'blocked', 'off'].includes(problem.code));
</script>

<div class="cap">
  {#if step === 'notice'}
    <div class="notice">
      <Icon name="camera" size={26} />
      <h3>{t('visNoticeTitle')}</h3>
      <p>{t(kind === 'meal' ? 'visNoticeMeal' : 'visNoticeRecipe')}</p>
      <button type="button" class="btn primary" onclick={understood}>{t('visNoticeOk')}</button>
    </div>
  {:else if step === 'ready'}
    <p class="note">{t(kind === 'meal' ? 'visIntroMeal' : 'visIntroRecipe')}</p>
    <div class="shoot">
      <PhotoActions tone="primary" take maxSide={1600} maxBytes={4 * 1024 * 1024} chooseLabel={t('visChoose')} takeLabel={t('visTake')} onpick={send} />
    </div>
    <p class="note small">{t('visPrivacy')}</p>
  {:else if step === 'waiting'}
    <div class="wait" role="status" aria-live="polite">
      {#if preview}<img src={preview} alt="" class="thumb" />{/if}
      <div class="bar" aria-hidden="true"><i></i></div>
      <strong>{t(kind === 'meal' ? 'visWaitMeal' : 'visWaitRecipe')}</strong>
      <p class="note">{t('visWaitHint')}</p>
      <button type="button" class="btn" onclick={cancel}>{t('cancel')}</button>
    </div>
  {:else if problem}
    <div class="problem" role="alert">
      {#if preview}<img src={preview} alt="" class="thumb" />{/if}
      <strong>{text(problem)}</strong>
      <div class="btns">
        {#if retryable}
          <button type="button" class="btn primary" onclick={again} disabled={remaining > 0}>
            {remaining > 0 ? t('visRetryIn', { n: remaining }) : t('visRetry')}
          </button>
        {/if}
        <button type="button" class="btn" onclick={another}>{t('visOther')}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .cap { display: flex; flex-direction: column; gap: 12px; }
  .notice { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 20px; display: flex; flex-direction: column; align-items: flex-start; gap: 10px; color: var(--green-text); }
  .notice h3 { font-size: 18px; color: var(--text); }
  .notice p { color: var(--text); font-size: 14.5px; line-height: 1.5; }
  .shoot { display: flex; flex-wrap: wrap; gap: 8px; }
  .small { font-size: 12.5px; }
  .wait, .problem { background: var(--paper); border-radius: 28px 28px 28px 8px; padding: 18px; display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
  .thumb { width: 100%; max-height: 220px; object-fit: cover; border-radius: 20px; display: block; }
  .wait strong, .problem strong { font-size: 16px; line-height: 1.35; }
  .bar { width: 100%; height: 8px; border-radius: 4px; background: var(--hairline); overflow: hidden; }
  .bar i { display: block; height: 100%; width: 38%; border-radius: 4px; background: var(--primary); animation: slide 1.5s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(270%); } }
  @media (prefers-reduced-motion: reduce) { .bar i { animation: none; width: 100%; opacity: 0.5; } }
  .btns { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
