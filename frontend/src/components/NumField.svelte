<script lang="ts">
  import { fmt, inputNumber, parseNumber } from '../lib/i18n';

  // A number that is shown formatted (2.100) and typed as plain digits. Commits on Enter or blur.
  let { value, min, max, label, onset, onbad, digits = 0, grouping = true, class: klass = '' }: {
    value: number; min: number; max: number; label: string; onset: (v: number) => void; onbad?: () => void;
    digits?: number; grouping?: boolean; class?: string;
  } = $props();

  let editing = $state(false);
  let text = $state('');
  const shown = $derived(editing ? text : grouping ? fmt(value, digits) : inputNumber(value));

  function focus(e: FocusEvent) {
    editing = true;
    text = inputNumber(value);
    const el = e.currentTarget as HTMLInputElement;
    queueMicrotask(() => el.select());
  }
  function commit() {
    if (!editing) return;
    editing = false;
    const v = parseNumber(text);
    if (v == null) return;
    if (Number.isNaN(v) || v < min || v > max) { onbad?.(); return; }
    onset(Math.round(v * 10 ** digits) / 10 ** digits);
  }
  function key(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
    else if (e.key === 'Escape') { editing = false; (e.currentTarget as HTMLInputElement).blur(); }
  }
</script>

<span class="nf {klass}"><span class="ghost" aria-hidden="true">{shown || ' '}</span><input inputmode={digits ? 'decimal' : 'numeric'} autocomplete="off"
  aria-label={label} value={shown} oninput={(e) => (text = e.currentTarget.value)} onfocus={focus} onblur={commit} onkeydown={key} /></span>

<style>
  .nf { position: relative; display: inline-block; max-width: 100%; }
  .ghost { visibility: hidden; white-space: pre; padding: 0 0.04em; }
  input { position: absolute; inset: 0; width: 100%; height: 100%; text-align: inherit; background: transparent; border: none; padding: 0; margin: 0; color: inherit; font: inherit; letter-spacing: inherit; border-radius: 8px; }
  input:focus-visible { outline: 3px solid currentColor; outline-offset: 3px; }
</style>
