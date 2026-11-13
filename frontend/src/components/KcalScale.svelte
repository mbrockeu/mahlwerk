<script lang="ts">
  import { fmt, t } from '../lib/i18n';
  import { KCAL_LIMITS, SCALE, clamp } from '../lib/goals';

  // Horizontal tick scale (the grinder dial unrolled) that works as a slider: drag or tap, arrow keys, Page up/down.
  let { value, onset }: { value: number; onset: (v: number) => void } = $props();

  const N = (SCALE.max - SCALE.min) / SCALE.step + 1; // 57 ticks
  let box: HTMLDivElement;
  let dragging = $state(false);

  const idx = $derived(clamp(Math.round((value - SCALE.min) / SCALE.step), 0, N - 1));
  const outside = $derived(value < SCALE.min || value > SCALE.max);
  const ticks = Array.from({ length: N }, (_, i) => i);
  const marks = [1500, 2000, 2500, 3000, 3500];

  function fromPointer(e: PointerEvent) {
    const r = box.getBoundingClientRect();
    const i = clamp(Math.round(((e.clientX - r.left) / r.width) * N - 0.5), 0, N - 1);
    onset(SCALE.min + i * SCALE.step);
  }
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    box.setPointerCapture(e.pointerId);
    box.focus({ preventScroll: true });
    fromPointer(e);
  }
  function move(e: PointerEvent) { if (dragging) fromPointer(e); }
  function up() { dragging = false; }
  function key(e: KeyboardEvent) {
    const step: Record<string, number> = { ArrowLeft: -50, ArrowDown: -50, ArrowRight: 50, ArrowUp: 50, PageDown: -250, PageUp: 250 };
    if (e.key in step) { e.preventDefault(); onset(clamp(value + step[e.key], KCAL_LIMITS.min, KCAL_LIMITS.max)); }
    else if (e.key === 'Home') { e.preventDefault(); onset(SCALE.min); }
    else if (e.key === 'End') { e.preventDefault(); onset(SCALE.max); }
  }
</script>

<div class="scale on-dark">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="track" bind:this={box} role="slider" tabindex="0" aria-label={t('gpScaleAria')} aria-orientation="horizontal"
    aria-valuemin={KCAL_LIMITS.min} aria-valuemax={KCAL_LIMITS.max} aria-valuenow={value} aria-valuetext={`${fmt(value)} kcal`}
    onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onkeydown={key}>
    <div class="ticks" aria-hidden="true">
      {#each ticks as i}<i class:on={i <= idx} class:big={i % 10 === 6}></i>{/each}
    </div>
    <span class="knob" class:out={outside} class:drag={dragging} style="left:{((idx + 0.5) / N) * 100}%" aria-hidden="true"></span>
  </div>
  <div class="marks" aria-hidden="true">
    {#each marks as m}<span style="left:{(((m - SCALE.min) / SCALE.step + 0.5) / N) * 100}%">{fmt(m)}</span>{/each}
  </div>
</div>

<style>
  .scale { display: flex; flex-direction: column; gap: 6px; }
  .track { position: relative; height: 56px; cursor: pointer; touch-action: pan-y; border-radius: 12px; user-select: none; -webkit-user-select: none; }
  .track:focus-visible { outline: 3px solid var(--lime); outline-offset: 4px; }
  .ticks { position: absolute; inset: 14px 0; display: flex; gap: 0; align-items: center; pointer-events: none; }
  .ticks i { flex: 1 1 0; height: 22px; margin: 0 1.2px; border-radius: 1.5px; background: var(--green-tick); }
  .ticks i.big { height: 30px; }
  .ticks i.on { background: var(--lime); }
  .knob { position: absolute; top: 50%; width: 24px; height: 24px; margin: -12px 0 0 -12px; border-radius: 12px; background: var(--orange); border: 3px solid var(--green); box-shadow: 0 0 0 2px var(--orange); pointer-events: none; transition: left 90ms ease-out, transform 120ms; }
  .knob.out { background: var(--pink); box-shadow: 0 0 0 2px var(--pink); }
  .knob.drag { transform: scale(1.18); }
  .marks { position: relative; height: 16px; font-family: var(--f-mono); font-size: 11px; font-weight: 500; letter-spacing: 0.04em; color: var(--on-deep); opacity: 0.85; }
  .marks span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .marks span:first-child { transform: translateX(-30%); }
</style>
