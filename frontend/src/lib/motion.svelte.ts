// Small tween helper for the dial and the tick bars.

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** Ease-out with a slight overshoot: the pointer springs past its target and settles. */
export const spring = (t: number) => {
  const c1 = 2.2;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

export class Tweened {
  value = $state(0);
  #frame = 0;

  /** Jump without animation. */
  set(v: number) {
    cancelAnimationFrame(this.#frame);
    this.value = v;
  }

  /** Animate from the current value to `to`. */
  to(to: number, ms = 700, ease: (t: number) => number = easeOut, from = this.value) {
    cancelAnimationFrame(this.#frame);
    if (reducedMotion() || ms <= 0) { this.value = to; return; }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      this.value = from + (to - from) * ease(t);
      if (t < 1) this.#frame = requestAnimationFrame(step);
    };
    this.value = from;
    this.#frame = requestAnimationFrame(step);
  }

  stop() { cancelAnimationFrame(this.#frame); }
}
