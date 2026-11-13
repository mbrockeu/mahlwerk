// Colour theme: "auto" follows the device (and its changes while the app is open), "light" / "dark" are fixed.
// The choice is kept per device. index.html sets the same attributes before the first paint; this module keeps them current.
export type ThemePref = 'auto' | 'light' | 'dark';
const KEY = 'mahlwerk.theme';
const COLORS = { light: '#eceee9', dark: '#0f1512' } as const;

const read = (): ThemePref => {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* storage blocked: automatic */ }
  return 'auto';
};

export const theme = $state({ pref: read() });

const media = window.matchMedia('(prefers-color-scheme: dark)');
const resolve = (pref: ThemePref): 'light' | 'dark' => (pref === 'auto' ? (media.matches ? 'dark' : 'light') : pref);

function apply() {
  const mode = resolve(theme.pref);
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.themePref = theme.pref;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COLORS[mode]);
}

export function setThemePref(pref: ThemePref) {
  theme.pref = pref;
  try {
    if (pref === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref);
  } catch { /* the choice then lasts until the page closes */ }
  apply();
}

export function initTheme() {
  apply();
  media.addEventListener('change', () => { if (theme.pref === 'auto') apply(); });
  // another tab of the app changed the choice
  window.addEventListener('storage', (e) => { if (e.key === KEY) { theme.pref = read(); apply(); } });
}
