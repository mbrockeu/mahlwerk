// Geometry of the first-run tour: where the speech bubble goes and which steps exist. Pure functions, tested in tests/tour.test.mjs.

export interface Rect { left: number; top: number; width: number; height: number }
export interface Size { w: number; h: number }
export type Side = 'top' | 'bottom' | 'left' | 'right' | 'center';
export interface Placement {
  left: number;
  top: number;
  /** The side of the target the bubble sits on; `center` when nothing fits beside it (no pointer then). */
  side: Side;
  /** Offset of the pointer along the bubble's edge, from its top-left corner (px). */
  arrow: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** The spotlight: the target grown by `pad`, kept inside the viewport. */
export function spotlight(target: Rect, vp: Size, pad = 8): Rect {
  const left = Math.max(0, target.left - pad);
  const top = Math.max(0, target.top - pad);
  const right = Math.min(vp.w, target.left + target.width + pad);
  const bottom = Math.min(vp.h, target.top + target.height + pad);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Place a bubble of `size` next to `target` so that it lies completely inside the viewport (`margin` from every edge)
 * and does not cover the target. Order of sides: below, above, right, left – flipped to "above first" for targets in the
 * lower half and to "right first" for narrow targets near the left edge (the navigation rail). If no side has room
 * (a target as big as the screen), the bubble is centred over the lower part and has no pointer.
 */
export function placeBubble(target: Rect | null, size: Size, vp: Size, gap = 14, margin = 16): Placement {
  const maxLeft = vp.w - size.w - margin;
  const maxTop = vp.h - size.h - margin;
  // only the part of the target that is on screen counts; nothing on screen: centre the bubble
  if (target) {
    const l = Math.max(0, target.left), t = Math.max(0, target.top);
    const r = Math.min(vp.w, target.left + target.width), b = Math.min(vp.h, target.top + target.height);
    target = r - l > 0 && b - t > 0 ? { left: l, top: t, width: r - l, height: b - t } : null;
  }
  if (!target) return { left: clamp((vp.w - size.w) / 2, margin, maxLeft), top: clamp((vp.h - size.h) / 2, margin, maxTop), side: 'center', arrow: 0 };

  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  const right = target.left + target.width;
  const bottom = target.top + target.height;
  const lowerHalf = cy > vp.h / 2;
  const railLike = target.width < 140 && target.left < 160 && vp.w >= 700;
  const order: Side[] = railLike ? ['right', 'bottom', 'top', 'left'] : lowerHalf ? ['top', 'bottom', 'right', 'left'] : ['bottom', 'top', 'right', 'left'];

  for (const side of order) {
    let left: number, top: number, fits: boolean;
    if (side === 'bottom') { top = bottom + gap; left = clamp(cx - size.w / 2, margin, maxLeft); fits = top <= maxTop; }
    else if (side === 'top') { top = target.top - gap - size.h; left = clamp(cx - size.w / 2, margin, maxLeft); fits = top >= margin; }
    else if (side === 'right') { left = right + gap; top = clamp(cy - size.h / 2, margin, maxTop); fits = left <= maxLeft; }
    else { left = target.left - gap - size.w; top = clamp(cy - size.h / 2, margin, maxTop); fits = left >= margin; }
    if (!fits) continue;
    const vertical = side === 'top' || side === 'bottom';
    const arrow = vertical ? clamp(cx - left, 28, size.w - 28) : clamp(cy - top, 28, size.h - 28);
    return { left, top, side, arrow };
  }
  return { left: clamp(target.left + target.width / 2 - size.w / 2, margin, maxLeft), top: maxTop, side: 'center', arrow: 0 };
}

export interface StepDef { id: string; selectors: string[] }

/**
 * The steps in order and where to find their targets. Phone and desktop keep some things in different places: the phone's
 * round avatar opens the more menu ("menu"), the rail's round button is the profile ("profile"); each is invisible on the
 * other layout, so exactly one of the two is shown.
 */
export const STEPS: StepDef[] = [
  { id: 'ring', selectors: ['[data-tour="ring"]'] },
  { id: 'macros', selectors: ['[data-tour="macros"]'] },
  { id: 'meal', selectors: ['[data-tour="meal"]'] },
  { id: 'scan', selectors: ['[data-tour="scan"]'] },
  { id: 'history', selectors: ['[data-tour="nav-history"]'] },
  { id: 'menu', selectors: ['[data-tour="avatar"]'] },
  { id: 'profile', selectors: ['[data-tour="nav-profile"]'] },
];

/** The first visible element of a step (phone and desktop keep the same thing in different places), or null. */
export function findTarget(step: StepDef, query: (selector: string) => Element | null, visible: (el: Element) => boolean): Element | null {
  for (const sel of step.selectors) {
    const el = query(sel);
    if (el && visible(el)) return el;
  }
  return null;
}

/** The step to show when moving from `current` by `dir`, skipping steps whose target is missing; null when there is none. */
export function stepFrom(ids: string[], current: string | null, dir: 1 | -1): string | null {
  if (!ids.length) return null;
  const i = current == null ? (dir === 1 ? -1 : ids.length) : ids.indexOf(current);
  const next = i + dir;
  return next >= 0 && next < ids.length ? ids[next] : null;
}
