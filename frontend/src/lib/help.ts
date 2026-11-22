// The evaluation page in groups (tabs) and its help: one entry per card, grouped like the page. `target` is the id of an
// element on the page (the card's heading or the section); `title` reuses the card's own heading text, `text` is the help
// text (keys `hlp_<id>`). `needs` lists texts that say what the card needs before it shows anything. Tested in
// tests/help.test.mjs.

export const INSIGHT_TABS = ['overview', 'food', 'body', 'nutrients', 'foods'] as const;
export type InsightTab = (typeof INSIGHT_TABS)[number];
/** `?tab=` of the evaluation page; anything unknown is the overview. */
export const parseTab = (raw: string | null | undefined): InsightTab =>
  (INSIGHT_TABS as readonly string[]).includes(raw ?? '') ? (raw as InsightTab) : 'overview';

export interface HelpEntry {
  id: string;
  /** the group the card is in; null: about the whole page */
  tab: InsightTab | null;
  target: string | null;
  title: string;
  needs?: string[];
}

export const INSIGHTS_HELP: HelpEntry[] = [
  { id: 'controls', tab: null, target: null, title: 'hlpControlsT' },
  { id: 'overview', tab: 'overview', target: 'sec-ov', title: 'hlpOverviewT' },
  { id: 'review', tab: 'overview', target: 'h-review', title: 'revTitle' },
  { id: 'hints', tab: 'overview', target: 'h-hints', title: 'hintsTitle' },
  { id: 'calendar', tab: 'overview', target: 'h-cal', title: 'calTitle' },
  { id: 'kcal', tab: 'food', target: 'h-kcal', title: 'chartKcal' },
  { id: 'macros', tab: 'food', target: 'h-macro', title: 'macroTrend' },
  { id: 'weekdays', tab: 'food', target: 'h-wd', title: 'weekdaysTitle' },
  { id: 'meals', tab: 'food', target: 'h-meals', title: 'mealsTitle' },
  { id: 'weight', tab: 'body', target: 'h-weight', title: 'wtTitle' },
  { id: 'expenditure', tab: 'body', target: 'h-exp', title: 'expTitle',
    needs: ['expMissing_short_period', 'expMissing_few_logged_days', 'expMissing_few_weights', 'expMissing_weights_not_spread'] },
  { id: 'activity', tab: 'body', target: 'h-act', title: 'insActTitle' },
  { id: 'nutrients', tab: 'nutrients', target: 'h-nut', title: 'nutTitle' },
  { id: 'micros', tab: 'nutrients', target: 'h-micros', title: 'microsTitle' },
  { id: 'top', tab: 'foods', target: 'h-top', title: 'topTitle' },
  { id: 'foods', tab: 'foods', target: 'h-foods', title: 'foodsTitle' },
];

/** The element to scroll to: the card around a heading, else the element itself. */
export function scrollTarget(el: Element | null): Element | null {
  return el?.closest('.card, .panel') ?? el;
}
