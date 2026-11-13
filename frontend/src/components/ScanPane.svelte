<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '../lib/api';
  import { t } from '../lib/i18n';
  import { DEMO, DEMO_SAMPLE_CODE } from '../lib/demo';
  import { createScanner, normalizeCode, validGtin, type Scanner } from '../lib/scanner';
  import { openAmount, openEditor, pulseScan, ui } from '../lib/store.svelte';
  import type { Food, Meal } from '../lib/types';

  // With `onfood` the found food is handed over instead of opening the amount sheet (used when building a recipe).
  let { meal, day, onfood }: { meal: Meal; day: string; onfood?: (food: Food) => void } = $props();
  const handOver = (food: Food) => (onfood ? onfood(food) : openAmount({ food, meal, day }));

  let video: HTMLVideoElement;
  let scanner: Scanner | null = null;
  let running = $state(false);
  let status = $state('');
  let warn = $state(false);
  let torchOn = $state(false);
  let zoomOn = $state(false);
  let hasTorch = $state(false);
  let hasZoom = $state(false);
  let code = $state('');
  let waitingForEditor = false;
  let busy = $state(false);

  const say = (text: string, isWarn = false) => { status = text; warn = isWarn; };

  async function start() {
    say('');
    if (DEMO) { say(t('demoScan')); return; } // the public demo never opens the camera
    try {
      scanner ??= createScanner(video, (found) => void lookup(found));
      await scanner.start();
      running = true;
      hasTorch = scanner.hasTorch;
      hasZoom = scanner.hasZoom;
      say(t('aim'));
    } catch (err) {
      running = false;
      const reason = err instanceof Error ? err.name || err.message : 'error';
      say(t('noCamera', { reason }), true);
    }
  }

  async function lookup(raw: string) {
    const found = normalizeCode(raw);
    busy = true;
    say(t('loading', { code: found }));
    try {
      const food = await api.foodByBarcode(found);
      if (food.empty) { unknown(found, t('emptyBarcode')); return; }
      if (navigator.vibrate) navigator.vibrate(60);
      pulseScan();
      handOver(food);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) { unknown(found, t('unknownBarcode')); return; }
      const reason = err instanceof ApiError ? err.status || err.message : 'error';
      say(t('failed', { reason }), true);
      scanner?.resume(1500);
    } finally {
      busy = false;
    }
  }

  function unknown(found: string, notice: string) {
    say('');
    waitingForEditor = true;
    openEditor({ food: null, code: found, notice, onSaved: handOver });
  }

  // editor closed without saving: look for the next code again
  $effect(() => {
    if (!ui.editor && waitingForEditor) {
      waitingForEditor = false;
      say(running ? t('aim') : '');
      scanner?.resume(500);
    }
  });

  function submitManual(event: SubmitEvent) {
    event.preventDefault();
    const value = code.trim();
    if (!validGtin(value)) { say(t('invalid'), true); return; }
    code = '';
    scanner?.stop();
    running = false;
    void lookup(value);
  }

  async function toggle(kind: 'torch' | 'zoom') {
    if (!scanner) return;
    try {
      if (kind === 'torch') { torchOn = !torchOn; await scanner.setTorch(torchOn); }
      else { zoomOn = !zoomOn; await scanner.setZoom(zoomOn); }
    } catch { if (kind === 'torch') hasTorch = false; else hasZoom = false; }
  }

  onMount(() => {
    void start();
    return () => scanner?.stop();
  });
</script>

<div class="pane">
  <div class="viewport" class:live={running}>
    <video bind:this={video} playsinline muted autoplay></video>
    <div class="guide" aria-hidden="true"></div>
    {#if DEMO}
      <button class="btn lime start" disabled={busy} onclick={() => void lookup(DEMO_SAMPLE_CODE)}>{t('demoSample')}</button>
    {:else if !running}
      <button class="btn lime start" onclick={start}>{t('start')}</button>
    {/if}
    <div class="tools">
      {#if hasZoom}<button class="chip" class:on={zoomOn} aria-pressed={zoomOn} onclick={() => toggle('zoom')}>2×</button>{/if}
      {#if hasTorch}<button class="chip" class:on={torchOn} aria-pressed={torchOn} onclick={() => toggle('torch')}>{t('torch')}</button>{/if}
    </div>
  </div>
  <p class="note" class:warn role="status">{status}</p>
  <form onsubmit={submitManual}>
    <label class="field">
      <span class="sr-only">{t('manual')}</span>
      <input inputmode="numeric" pattern={String.raw`\d{8,14}`} autocomplete="off" placeholder={t('manual')} bind:value={code} />
    </label>
    <button class="btn" disabled={busy}>{t('lookup')}</button>
  </form>
</div>

<style>
  .pane { display: flex; flex-direction: column; gap: 10px; }
  .viewport { position: relative; border-radius: 28px 28px 28px 8px; overflow: hidden; background: var(--deep); aspect-ratio: 4 / 3; }
  video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .guide {
    position: absolute; left: 12%; right: 12%; top: 30%; bottom: 30%; border-radius: 16px; border: 3px dashed var(--lime); opacity: 0.85; pointer-events: none;
  }
  .viewport:not(.live) .guide { display: none; }
  .start { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
  .tools { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 8px; }
  form { display: flex; gap: 8px; align-items: flex-end; }
  form .field { flex: 1; }
</style>
