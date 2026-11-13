// Hash routing: #/, #/history?range=30, #/products, #/recipes, #/weight, #/profile, #/badges
export type Route = 'today' | 'history' | 'products' | 'recipes' | 'weight' | 'profile' | 'badges' | 'admin';
const ROUTES: Record<string, Route> = {
  '': 'today', '/': 'today', '/history': 'history', '/products': 'products', '/recipes': 'recipes', '/weight': 'weight', '/profile': 'profile', '/badges': 'badges', '/admin': 'admin',
};
const split = (): [string, string] => {
  const hash = location.hash.replace(/^#/, '');
  const i = hash.indexOf('?');
  return i < 0 ? [hash, ''] : [hash.slice(0, i), hash.slice(i + 1)];
};
// old links: #/products?tab=recipes (recipes used to be a tab of the product page) now lead to the recipe page
const legacy = () => {
  const [path, query] = split();
  if (path === '/products' && new URLSearchParams(query).get('tab') === 'recipes') history.replaceState(null, '', '#/recipes');
};
const parse = (): Route => { legacy(); return ROUTES[split()[0]] ?? 'today'; };

export const router = $state({ route: parse(), query: new URLSearchParams(split()[1]) });
/** A view with unsaved work can hold navigation back: `block(target)` returns true to stop it (the hash is put back). */
export const guard: { block: null | ((targetHash: string) => boolean) } = { block: null };
let lastHash = location.hash;
window.addEventListener('hashchange', () => {
  const route = parse();
  if (guard.block && route !== router.route && guard.block(location.hash)) {
    history.replaceState(null, '', lastHash || '#/');
    return;
  }
  lastHash = location.hash;
  const changed = route !== router.route;
  router.route = route;
  router.query = new URLSearchParams(split()[1]);
  if (changed) window.scrollTo({ top: 0 });
});

export const hrefOf = (route: Route) => (route === 'today' ? '#/' : `#/${route}`);
export const navigate = (route: Route) => { location.hash = hrefOf(route); };

/** Replace the query of the current route (no new history entry, no scroll). */
export function setQuery(params: Record<string, string>) {
  const query = new URLSearchParams(params);
  const text = query.toString();
  history.replaceState(null, '', `${hrefOf(router.route)}${text ? `?${text}` : ''}`);
  router.query = query;
}
