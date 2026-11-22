// The help for the evaluation page: one entry per card, in the order of the page. `target` is the id of an element on the
// page (the card's heading or the section); `title` reuses the card's own heading text, `text` is the help text
// (keys `hlp_<id>`). `needs` lists texts that say what the card needs before it shows anything. Tested in tests/help.test.mjs.

export interface HelpEntry {
  id: string;
  target: string | null;
  title: string;
  needs?: string[];
}

export const INSIGHTS_HELP: HelpEntry[] = [
  { id: 'controls', target: null, title: 'hlpControlsT' },
  { id: 'overview', target: 'sec-ov', title: 'secOverview' },
  { id: 'review', target: 'h-review', title: 'revTitle' },
  { id: 'hints', target: 'h-hints', title: 'hintsTitle' },
  { id: 'kcal', target: 'h-kcal', title: 'chartKcal' },
  { id: 'activity', target: 'h-act', title: 'insActTitle' },
  { id: 'macros', target: 'h-macro', title: 'macroTrend' },
  { id: 'weight', target: 'h-weight', title: 'wtTitle' },
  { id: 'expenditure', target: 'h-exp', title: 'expTitle',
    needs: ['expMissing_short_period', 'expMissing_few_logged_days', 'expMissing_few_weights', 'expMissing_weights_not_spread'] },
  { id: 'nutrients', target: 'h-nut', title: 'nutTitle' },
  { id: 'calendar', target: 'h-cal', title: 'calTitle' },
  { id: 'weekdays', target: 'h-wd', title: 'weekdaysTitle' },
  { id: 'meals', target: 'h-meals', title: 'mealsTitle' },
  { id: 'micros', target: 'h-micros', title: 'microsTitle' },
  { id: 'top', target: 'h-top', title: 'topTitle' },
  { id: 'foods', target: 'h-foods', title: 'foodsTitle' },
];

/** The element to scroll to: the card around a heading, else the element itself. */
export function scrollTarget(el: Element | null): Element | null {
  return el?.closest('.card, .panel') ?? el;
}
