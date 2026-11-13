// A media query as reactive state: `const wide = media('(min-width: 1280px)')`, then `wide.on`.
export function media(query: string) {
  const q = window.matchMedia(query);
  const state = $state({ on: q.matches });
  q.addEventListener('change', () => { state.on = q.matches; });
  return state;
}

/** Wide windows (from 1280 px) get the split layouts of Products and Weight. */
export const wide = media('(min-width: 1280px)');
