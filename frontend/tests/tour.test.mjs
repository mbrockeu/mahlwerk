import test from 'node:test';
import assert from 'node:assert/strict';
import { placeBubble, spotlight, findTarget, stepFrom, STEPS } from '../src/lib/tour.ts';

const inside = (p, size, vp, m = 16) => p.left >= m && p.top >= m && p.left + size.w <= vp.w - m && p.top + size.h <= vp.h - m;
const overlaps = (p, size, r) => p.left < r.left + r.width && p.left + size.w > r.left && p.top < r.top + r.height && p.top + size.h > r.top;

test('bubble below a target near the top, centred on it', () => {
  const vp = { w: 1440, h: 900 }, size = { w: 340, h: 200 }, target = { left: 600, top: 100, width: 400, height: 200 };
  const p = placeBubble(target, size, vp);
  assert.equal(p.side, 'bottom');
  assert.equal(p.left, 800 - 170);
  assert.ok(inside(p, size, vp) && !overlaps(p, size, target));
});

test('bubble above a target in the lower half (phone scan button)', () => {
  const vp = { w: 390, h: 844 }, size = { w: 340, h: 190 }, target = { left: 300, top: 760, width: 60, height: 60 };
  const p = placeBubble(target, size, vp);
  assert.equal(p.side, 'top');
  assert.ok(inside(p, size, vp) && !overlaps(p, size, target));
  assert.ok(p.arrow >= 28 && p.arrow <= size.w - 28);
});

test('narrow target on the rail: bubble to its right', () => {
  const vp = { w: 1440, h: 900 }, size = { w: 340, h: 190 }, target = { left: 28, top: 158, width: 52, height: 52 };
  const p = placeBubble(target, size, vp);
  assert.equal(p.side, 'right');
  assert.ok(inside(p, size, vp) && !overlaps(p, size, target));
});

test('never leaves the viewport, whatever the target', () => {
  for (const vp of [{ w: 320, h: 568 }, { w: 390, h: 844 }, { w: 844, h: 390 }, { w: 1440, h: 900 }, { w: 2560, h: 1440 }]) {
    const size = { w: Math.min(340, vp.w - 32), h: 180 };
    for (let x = -50; x <= vp.w; x += 97) for (let y = -50; y <= vp.h; y += 89) {
      const target = { left: x, top: y, width: 60 + (x % 200), height: 50 + (y % 120) };
      const p = placeBubble(target, size, vp);
      assert.ok(inside(p, size, vp), `${JSON.stringify(vp)} ${JSON.stringify(target)} ${JSON.stringify(p)}`);
      if (p.side !== 'center') assert.ok(!overlaps(p, size, target));
    }
  }
});

test('a target as big as the screen: centred without pointer', () => {
  const vp = { w: 390, h: 600 }, size = { w: 340, h: 180 };
  const p = placeBubble({ left: 0, top: 0, width: 390, height: 600 }, size, vp);
  assert.equal(p.side, 'center');
  assert.ok(inside(p, size, vp));
});

test('no target: centred', () => {
  const p = placeBubble(null, { w: 300, h: 200 }, { w: 1000, h: 800 });
  assert.deepEqual([p.left, p.top, p.side], [350, 300, 'center']);
});

test('spotlight grows by the padding and stays in the viewport', () => {
  assert.deepEqual(spotlight({ left: 100, top: 100, width: 50, height: 40 }, { w: 400, h: 400 }, 8), { left: 92, top: 92, width: 66, height: 56 });
  assert.deepEqual(spotlight({ left: 2, top: 380, width: 50, height: 40 }, { w: 400, h: 400 }, 8), { left: 0, top: 372, width: 60, height: 28 });
});

test('findTarget takes the first visible selector', () => {
  const els = { '#a': { v: false }, '#b': { v: true } };
  const query = (s) => els[s] ?? null;
  const visible = (e) => e.v;
  assert.equal(findTarget({ id: 'x', selectors: ['#a', '#b'] }, query, visible), els['#b']);
  assert.equal(findTarget({ id: 'x', selectors: ['#a', '#c'] }, query, visible), null);
});

test('stepFrom skips to the neighbour and ends at the borders', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(stepFrom(ids, null, 1), 'a');
  assert.equal(stepFrom(ids, 'a', 1), 'b');
  assert.equal(stepFrom(ids, 'c', 1), null);
  assert.equal(stepFrom(ids, 'a', -1), null);
  assert.equal(stepFrom(ids, 'c', -1), 'b');
  assert.equal(stepFrom(['a', 'c'], 'b', 1), 'a'); // current vanished from the list: start over from the first
  assert.equal(stepFrom([], null, 1), null);
});

// which steps remain when only some targets are on screen (what the real page does with getClientRects)
const shown = (visibleSelectors) => STEPS.filter((s) => findTarget(s, (sel) => ({ sel }), (el) => visibleSelectors.includes(el.sel))).map((s) => s.id);
const common = ['[data-tour="ring"]', '[data-tour="macros"]', '[data-tour="meal"]', '[data-tour="scan"]', '[data-tour="nav-history"]'];

test('phone: the tour ends with the more menu, not the profile', () => {
  assert.deepEqual(shown([...common, '[data-tour="avatar"]']), ['ring', 'macros', 'meal', 'scan', 'history', 'menu']);
});

test('desktop: the tour ends with the rail profile button, not the menu', () => {
  assert.deepEqual(shown([...common, '[data-tour="nav-profile"]']), ['ring', 'macros', 'meal', 'scan', 'history', 'profile']);
});

test('steps pointing at navigation use selectors that exist in the navigation', () => {
  // Nav.svelte puts data-tour="nav-{route}" on every link: Insights must stay one of them
  assert.ok(STEPS.some((s) => s.selectors.includes('[data-tour="nav-history"]')));
  assert.equal(new Set(STEPS.map((s) => s.id)).size, STEPS.length);
});
