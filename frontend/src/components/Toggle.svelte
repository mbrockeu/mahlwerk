<script lang="ts">
  // On/off switch: the whole row is one 44px+ target, ink track with a lime knob when on.
  let { checked, label, sub, disabled = false, bare = false, onchange }: { checked: boolean; label: string; sub?: string; disabled?: boolean; bare?: boolean; onchange: () => void } = $props();
</script>

<button type="button" class="sw" class:bare role="switch" aria-checked={checked} aria-label={bare ? label : undefined} {disabled} onclick={onchange}>
  {#if !bare}<span class="txt">{label}{#if sub}<small>{sub}</small>{/if}</span>{/if}
  <span class="track" aria-hidden="true"><span class="knob"></span></span>
</button>

<style>
  .sw { width: 100%; min-height: 56px; padding: 6px 4px 6px 16px; border-radius: 20px 20px 20px 8px; background: var(--stone); display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; font-weight: 600; font-size: 15px; }
  .txt { display: flex; flex-direction: column; }
  small { font-family: var(--f-mono); font-size: 12px; font-weight: 500; color: var(--quiet); }
  .track { width: 60px; height: 40px; border-radius: 20px; background: var(--paper); border: 2px solid var(--quiet); position: relative; flex-shrink: 0; transition: background 160ms, border-color 160ms; margin-right: 4px; }
  .knob { position: absolute; top: 4px; left: 4px; width: 28px; height: 28px; border-radius: 14px; background: var(--quiet); transition: transform 200ms cubic-bezier(0.2, 0.9, 0.3, 1.2), background 160ms; }
  .sw[aria-checked='true'] .track { background: var(--toggle-on); border-color: var(--toggle-on); }
  .sw[aria-checked='true'] .knob { transform: translateX(20px); background: var(--lime); }
  /* only the track (the connector cards put one switch in their header; the name is the aria-label) */
  .sw.bare { width: auto; min-height: 48px; padding: 4px 0; background: transparent; border-radius: 24px; }
  .sw.bare .track { margin-right: 0; }
  .sw[disabled] { opacity: 0.6; cursor: default; }
</style>
