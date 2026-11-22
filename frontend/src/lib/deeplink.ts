// Direct links for shortcuts and the iOS app: /?go=scan, /?go=add&meal=breakfast, /?go=recent, /?go=templates, /?go=photo.
// A query parameter (not the hash) so it survives the sign-in redirect. Opens the add sheet for today; without
// `meal` the meal follows the time of day. Unknown values are ignored. `photo` opens the sheet on "Photo of the meal"
// (only where photo recognition is ready; otherwise the link just opens today).
export type DeepLink = { tab: 'scan' | 'search' | 'recent' | 'templates'; meal: 'breakfast' | 'lunch' | 'dinner' | 'snack' | null; photo: boolean };

const TABS: Record<string, DeepLink['tab']> = { scan: 'scan', add: 'search', search: 'search', recent: 'recent', templates: 'templates', photo: 'search' };
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

export function parseDeepLink(search: string): DeepLink | null {
  const q = new URLSearchParams(search);
  const tab = TABS[q.get('go') ?? ''];
  if (!tab) return null;
  const m = q.get('meal');
  return { tab, meal: (MEALS as readonly string[]).includes(m ?? '') ? (m as DeepLink['meal']) : null, photo: q.get('go') === 'photo' };
}

/** The search without `go` and `meal` (other parameters such as `engine` stay). */
export function stripDeepLink(search: string): string {
  const q = new URLSearchParams(search);
  q.delete('go');
  q.delete('meal');
  const s = q.toString();
  return s ? `?${s}` : '';
}
