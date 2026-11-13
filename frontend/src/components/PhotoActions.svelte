<script lang="ts">
  // Buttons that bring a photo into a recipe: "Add/Change photo" (the file chooser; on a phone the system offers camera or library) and, on a
  // touch device, "Take photo" (the camera straight away). The picture is shrunk in the browser first (a phone photo is huge and a reverse
  // proxy has an upload limit), then handed to `onpick`; what happens next (upload now, or with the recipe) is the caller's business.
  import { shrink } from '../lib/image';
  import { t } from '../lib/i18n';
  import { toast } from '../lib/store.svelte';
  import Icon from './Icon.svelte';

  // `tone`: ghost (on the green head block), plain (in a form), icon (a round button on the picture itself). `take`: offer the camera button too.
  let { has = false, busy = false, onpick, tone = 'ghost', take = false }:
    { has?: boolean; busy?: boolean; onpick: (image: Blob) => void | Promise<void>; tone?: 'ghost' | 'plain' | 'icon'; take?: boolean } = $props();
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const coarse = $derived(take && touch);
  let choose: HTMLInputElement;
  let shoot: HTMLInputElement;

  async function picked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // the same file can be chosen again
    if (!file) return;
    let blob: Blob;
    try { blob = await shrink(file); } catch { toast(t('imgUnreadable')); return; }
    await onpick(blob);
  }
</script>

{#if tone === 'icon'}
  <button type="button" class="ic" disabled={busy} onclick={() => choose.click()} aria-label={busy ? t('imgBusy') : has ? t('imgChange') : t('imgAdd')} title={has ? t('imgChange') : t('imgAdd')}>
    <Icon name="camera" size={20} />
  </button>
{:else}
  <button type="button" class="b {tone}" disabled={busy} onclick={() => choose.click()}>
    <Icon name="camera" size={18} />{busy ? t('imgBusy') : has ? t('imgChange') : t('imgAdd')}
  </button>
{/if}
{#if coarse}
  <button type="button" class="b {tone}" disabled={busy} onclick={() => shoot.click()}><Icon name="camera" size={18} />{t('imgTake')}</button>
{/if}
<input bind:this={choose} type="file" accept="image/*" hidden onchange={picked} data-testid="photo-choose" />
<input bind:this={shoot} type="file" accept="image/*" capture="environment" hidden onchange={picked} data-testid="photo-take" />

<style>
  .b { min-height: 46px; padding: 0 18px; border-radius: 24px 24px 24px 8px; font-weight: 700; font-size: 15px; display: inline-flex; align-items: center; gap: 8px; }
  .b:disabled { opacity: 0.6; }
  .b.ghost { background: transparent; color: #fff; box-shadow: inset 0 0 0 2px var(--green-tick); }
  .ic { width: 44px; height: 44px; border-radius: 16px 16px 16px 6px; background: var(--paper); color: var(--text); display: inline-flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(23, 33, 28, 0.18); }
  .ic:disabled { opacity: 0.6; }
  .b.plain { background: var(--stone); color: var(--text); box-shadow: inset 0 0 0 2px var(--hairline); }
</style>
