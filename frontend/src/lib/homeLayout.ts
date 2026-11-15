// The cards of the day view ("Heute") and their arrangement: one order for all screens, the width only counts on wide ones.
// Pure functions; the view keeps the list and saves it as `settings.home`.

export const HOME_IDS = ['ring', 'macros', 'fasting', 'water', 'activity', 'weight', 'meals', 'micros', 'suggestions'] as const;
export type HomeId = (typeof HOME_IDS)[number];

export interface HomeCard {
  id: HomeId;
  hidden: boolean;
  wide: boolean;
}

const WIDE: Record<HomeId, boolean> = {
  ring: false, macros: false, fasting: true, water: false, activity: false, weight: true, meals: true, micros: true, suggestions: false,
};

export const DEFAULT_HOME: readonly HomeCard[] = HOME_IDS.map((id) => ({ id, hidden: false, wide: WIDE[id] }));

const isId = (v: unknown): v is HomeId => typeof v === 'string' && (HOME_IDS as readonly string[]).includes(v);

/** A fresh default list (the view mutates copies, never the constant). */
export const defaultHome = (): HomeCard[] => DEFAULT_HOME.map((c) => ({ ...c }));

/** What the server stored (or null, or rubbish) as a complete list: unknown and doubled ids dropped, missing ones appended. */
export function normalize(stored: unknown): HomeCard[] {
  if (!Array.isArray(stored)) return defaultHome();
  const seen = new Set<HomeId>();
  const out: HomeCard[] = [];
  for (const item of stored) {
    const id = (item as { id?: unknown } | null)?.id;
    if (!isId(id) || seen.has(id)) continue;
    seen.add(id);
    const c = item as Partial<HomeCard>;
    out.push({ id, hidden: c.hidden === true, wide: typeof c.wide === 'boolean' ? c.wide : WIDE[id] });
  }
  for (const c of DEFAULT_HOME) if (!seen.has(c.id)) out.push({ ...c });
  return out;
}

/** Move the card at `from` to position `to`; out-of-range or equal indexes change nothing. */
export function move(list: readonly HomeCard[], from: number, to: number): HomeCard[] {
  const next = list.map((c) => ({ ...c }));
  if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

const patch = (list: readonly HomeCard[], id: HomeId, change: (c: HomeCard) => void): HomeCard[] =>
  list.map((c) => { const n = { ...c }; if (n.id === id) change(n); return n; });

export const toggleHidden = (list: readonly HomeCard[], id: HomeId): HomeCard[] => patch(list, id, (c) => { c.hidden = !c.hidden; });
export const toggleWide = (list: readonly HomeCard[], id: HomeId): HomeCard[] => patch(list, id, (c) => { c.wide = !c.wide; });

/** The same arrangement (order, hidden, width)? */
export const sameHome = (a: readonly HomeCard[], b: readonly HomeCard[]): boolean =>
  a.length === b.length && a.every((c, i) => c.id === b[i].id && c.hidden === b[i].hidden && c.wide === b[i].wide);
