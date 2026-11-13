// Invented web pages for the mock and the demo: a recipe host that does not exist (`recipes.example.org`), so nothing is ever fetched.
// A page has what the schema.org data would carry: name, portions, nutrition as written (per serving unless the page is "whole"), ingredient lines.
// `interpretWeb` is the small counterpart of webrecipes.interpret on the server (division by the portions, warnings, what blocks a take-over).
import type { Per100, WebPreview } from './types';

export interface MockWebPage { name: string; portions: number | null; values: Partial<Per100> & { sodium?: number } | null; serving?: string; ingredients: string[] }

type Names = (de: string, en: string) => string;
export const buildWebPages = (L: Names): Record<string, MockWebPage> => ({
  'recipes.example.org/rezepte/linsen-bolognese': {
    name: L('Linsen-Bolognese mit Vollkornspaghetti', 'Lentil bolognese with wholewheat spaghetti'), portions: 4, serving: L('1 Portion', '1 serving'),
    values: { kcal: 548, fat: 11.5, saturated_fat: 1.8, carbs: 82, sugars: 11, fiber: 14.5, protein: 24, salt: 1.2, sodium: 480 },
    ingredients: [L('250 g rote Linsen', '250 g red lentils'), L('400 g Vollkornspaghetti', '400 g wholewheat spaghetti'), L('1 Dose gehackte Tomaten (400 g)', '1 can chopped tomatoes (400 g)'),
      L('2 Karotten, gewürfelt', '2 carrots, diced'), L('1 Zwiebel', '1 onion'), L('2 EL Olivenöl', '2 tbsp olive oil'), L('Salz, Pfeffer, Oregano', 'Salt, pepper, oregano')],
  },
  'recipes.example.org/rezepte/ofengemuese-mit-feta': {
    name: L('Ofengemüse mit Feta', 'Roasted vegetables with feta'), portions: 4, serving: '',
    // the page gives the values for the whole tray: the preview warns and the switch "whole recipe" divides them by four
    values: { kcal: 2240, fat: 120, saturated_fat: 52, carbs: 188, sugars: 64, fiber: 36, protein: 96, salt: 9.6, sodium: 3840 },
    ingredients: [L('1 Zucchini', '1 zucchini'), L('2 Paprika', '2 bell peppers'), L('1 rote Zwiebel', '1 red onion'), L('400 g Süßkartoffeln', '400 g sweet potatoes'), L('200 g Feta', '200 g feta'), L('3 EL Olivenöl', '3 tbsp olive oil')],
  },
  'recipes.example.org/rezepte/dinkelbrot': {
    name: L('Dinkelbrot im Topf', 'Spelt bread in a pot'), portions: 12, values: null,
    ingredients: [L('500 g Dinkelmehl 630', '500 g spelt flour'), L('1 TL Salz', '1 tsp salt'), L('1 Würfel Hefe', '1 cube yeast'), L('400 ml Wasser', '400 ml water')],
  },
  'recipes.example.org/shakshuka-vom-blech': {
    name: L('Shakshuka vom Blech', 'Sheet-pan shakshuka'), portions: 4, values: { kcal: 310, fat: 17, saturated_fat: 5, carbs: 22, sugars: 9, fiber: 6, protein: 17, salt: 1.7, sodium: 680 },
    ingredients: [L('6 Eier', '6 eggs'), L('2 Dosen Tomaten', '2 cans tomatoes'), L('2 Paprika', '2 bell peppers'), L('100 g Feta', '100 g feta')],
  },
});
/** Pages that answer without recipe data. */
export const NO_RECIPE = ['recipes.example.org/artikel/kochen-im-winter'];

const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_ga|_gl|yclid|twclid|ttclid|wbraid|gbraid|ref_src|ref_url|spm|si)$/i;

/** `[host/path?query]` key and the normalised address, or a message why the text is no fetchable address (same rules as webrecipes.check_address, shorter). */
export function normaliseWeb(text: string): { address: string; key: string; host: string } | string {
  const bad = 'this is not a web address that can be fetched (an http or https address of a public website, standard port)';
  let url: URL;
  try { url = new URL(text.trim()); } catch { return bad; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return bad;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[') || /\s/.test(host)) return bad;
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const path = url.pathname || '/';
  const port = url.port && url.port !== (url.protocol === 'https:' ? '443' : '80') ? `:${url.port}` : '';
  return { address: `${url.protocol}//${host}${port}${path}${query}`, key: `${host}${path}${query}`.replace(/\/$/, ''), host: host.replace(/^www\./, '') };
}

const num = (v: number | null | undefined) => (v == null ? null : Math.round(v * 100) / 100);

export function interpretWeb(page: MockWebPage, opts: { whole: boolean; portions: number | null; name?: string }, address: string, host: string, foodId: number | null): WebPreview {
  const portions = opts.portions && opts.portions > 0 ? opts.portions : page.portions;
  const warnings: WebPreview['warnings'] = [];
  if (opts.portions == null && page.portions == null) warnings.push('no_portions');
  const name = opts.name != null ? opts.name.trim().replace(/\s+/g, ' ') : page.name;
  const v = page.values;
  let blocked: WebPreview['blocked'] = null;
  const divisor = opts.whole ? portions ?? 1 : 1;
  if (opts.whole && portions == null) blocked = 'whole_needs_portions';
  const div = (x: number | null | undefined) => (x == null ? null : x / divisor);
  const per: Per100 = { kcal: num(div(v?.kcal)), fat: num(div(v?.fat)), saturated_fat: num(div(v?.saturated_fat)), carbs: num(div(v?.carbs)), sugars: num(div(v?.sugars)), fiber: num(div(v?.fiber)), protein: num(div(v?.protein)), salt: num(div(v?.salt)) };
  if (!name) blocked = blocked ?? 'no_name';
  if (per.kcal == null) blocked = blocked ?? 'no_energy';
  else if (per.kcal > 5000) blocked = blocked ?? 'too_high';
  if (per.kcal != null && blocked !== 'too_high') {
    if (per.protein != null && per.carbs != null && per.fat != null) {
      const est = 4 * per.protein + 4 * per.carbs + 9 * per.fat;
      if (Math.abs(per.kcal - est) > Math.max(80, 0.35 * est)) warnings.push('energy_mismatch');
    }
    if (!opts.whole && (((portions ?? 1) > 1 && per.kcal > 1500) || [per.carbs, per.fat, per.protein].some((x) => (x ?? 0) > 150))) warnings.push('maybe_whole');
  }
  return {
    url: address, host, name, portions: portions ?? null, page_portions: page.portions, per_portion: per, extra: v?.sodium != null ? { sodium: num(div(v.sodium)) as number } : {},
    complete: per.kcal != null && per.fat != null && per.carbs != null && per.protein != null, whole: opts.whole, serving_size: page.serving ?? '',
    ingredients: [...page.ingredients], warnings, blocked, food_id: foodId,
  };
}
