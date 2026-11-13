// Swiping a bottom sheet away: from the drag (how far it was pulled down, how long it took, how high the sheet is) decide whether it
// closes or springs back. Far enough (120 px or a quarter of the height) closes; a quick flick closes after a short pull.
const CLOSE_DISTANCE = 120;
const CLOSE_FRACTION = 0.25;
const FLICK_SPEED = 0.6; // px per ms
const FLICK_MIN = 40; // a flick needs at least this much travel

export function swipeDecision(dy: number, ms: number, height: number): 'close' | 'back' {
  if (!(dy > 0)) return 'back';
  if (dy >= CLOSE_DISTANCE || (height > 0 && dy >= height * CLOSE_FRACTION)) return 'close';
  if (dy >= FLICK_MIN && ms > 0 && dy / ms >= FLICK_SPEED) return 'close';
  return 'back';
}

/** Only downwards moves the sheet; upwards a little resistance is not wanted, the sheet just stays. */
export const dragOffset = (dy: number) => Math.max(0, dy);
