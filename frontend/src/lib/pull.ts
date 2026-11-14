// Pull to refresh: from the first movements of a touch decide whether it is a pull down (and not a sideways swipe or a scroll),
// how far the indicator follows the finger, and whether letting go refreshes.
export const PULL_THRESHOLD = 70; // px of indicator travel after which letting go refreshes
export const PULL_MAX = 110; // the indicator never goes further down than this
const DECIDE_AFTER = 10; // px of finger travel before the direction is judged
const VERTICAL_RATIO = 1.5; // mostly vertical: |dy| must be this many times |dx|

export type PullIntent = 'wait' | 'pull' | 'ignore';

/** `wait` while the finger has hardly moved; `pull` for a mostly vertical move down; `ignore` for anything else (sideways, upwards). */
export function pullIntent(dx: number, dy: number): PullIntent {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < DECIDE_AFTER) return 'wait';
  return dy > 0 && ay >= ax * VERTICAL_RATIO ? 'pull' : 'ignore';
}

/** Rubber-band damping: the indicator follows the finger at first and slows down towards `PULL_MAX`. */
export function pullOffset(dy: number): number {
  if (!(dy > 0)) return 0;
  return PULL_MAX * (1 - Math.exp(-dy / (PULL_MAX * 1.1)));
}

export const pullReady = (offset: number) => offset >= PULL_THRESHOLD;
