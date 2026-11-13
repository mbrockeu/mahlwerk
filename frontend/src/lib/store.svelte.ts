// Shared UI state: selected day, open sheets, refresh signal, toast, profile.
import { api, hooks, view } from './api';
import { t } from './i18n';
import { today } from './date';
import { DEMO } from './demo';
import type { Account, BadgeCode, SignInMode, Food, Entry, Me, Meal, Recipe, VisionState, Workout } from './types';

export type AddTab = 'scan' | 'search' | 'recent' | 'templates' | 'cookidoo';

export interface AmountRequest {
  food?: Food;
  entry?: Entry;
  meal: Meal;
  day: string;
  lastAmount?: number;
  /** The amount the dialog starts with, in grams/millilitres as booked (a suggestion's recommended amount). */
  amount?: number;
}
export interface EditorRequest {
  food: Food | null;
  code?: string | null;
  notice?: string;
  /** Called with the saved food; without it the editor just closes. */
  onSaved?: (food: Food) => void;
}

export interface RecipeRequest {
  /** The recipe to edit, or null for a new one. */
  recipe: Recipe | null;
  /** A new recipe that starts from a web page without nutrition values: its name, portions and (for this sitting only) its ingredient lines. */
  draft?: {
    name: string; portions: number | null; ingredients: string[]; host: string;
    /** The draft comes from a photo of a recipe (not a web page): the review of the lines opens at once, with the values printed on the photo for comparison. */
    photo?: { nutrition: { kcal: number | null; protein_g: number | null; fat_g: number | null; carbs_g: number | null } | null };
  };
}

export interface WorkoutRequest {
  day: string;
  /** The workout to edit, or null for a new one. */
  workout: Workout | null;
}

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export const ui = $state({
  day: today(),
  today: today(),
  add: null as null | { meal: Meal; day: string; tab: AddTab },
  amount: null as null | AmountRequest,
  editor: null as null | EditorRequest,
  recipe: null as null | RecipeRequest,
  workout: null as null | WorkoutRequest,
  version: 0,
  pulse: 0,
  toast: '',
  toastAction: null as null | ToastAction,
  me: null as Me | null,
  /** Photo recognition: null until asked (`loadVision`). */
  vision: null as VisionState | null,
  /** Newly reached badges being celebrated right now. */
  moment: null as null | BadgeCode[],
});

export function mealByTime(date = new Date()): Meal {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h < 10.5) return 'breakfast';
  if (h < 14.5) return 'lunch';
  if (h < 17) return 'snack';
  return 'dinner';
}

export const openAdd = (meal: Meal, day = ui.day, tab: AddTab = 'search') => { ui.add = { meal, day, tab }; };
export const closeAdd = () => { ui.add = null; };
export const openAmount = (req: AmountRequest) => { ui.add = null; ui.amount = req; };
/** True while an admin looks at the built-in demo account: shared products and recipes are read-only there (the server says no as well). */
export const viewingDemo = () => ui.me?.demo_account?.viewing === true;
export const openEditor = (req: EditorRequest) => { if (viewingDemo()) { toast(t('demoAcctBlocked')); return; } ui.editor = req; };
export const openRecipe = (req: RecipeRequest) => { if (viewingDemo()) { toast(t('demoAcctBlocked')); return; } ui.recipe = req; };
export const openWorkout = (req: WorkoutRequest) => { ui.workout = req; };
/** Photo recognition can be offered: the connector is on and configured, and this is not the demo account (it has no write access). The demo SITE has the mock. */
export const visionReady = () => ui.vision?.ready === true && !viewingDemo();
/** Asks the server whether photo recognition is ready (a failure means: not offered). */
export async function loadVision(): Promise<void> {
  try { ui.vision = await api.visionStatus(); } catch { ui.vision = { enabled: false, configured: false, ready: false, per_hour: 0 }; }
}
export const changed = () => { ui.version += 1; checkBadges(); };
export const pulseScan = () => { ui.pulse += 1; };

let badgeTimer = 0;
/** After an action: ask for new badges and celebrate them once. Several actions in a row collapse into one check;
 * the badges are marked as seen as soon as the moment shows, so it never repeats. Off when `playful` is off. */
export function checkBadges() {
  clearTimeout(badgeTimer);
  badgeTimer = window.setTimeout(async () => {
    if (ui.me?.settings?.playful === false || ui.moment) return;
    try {
      const { new: fresh } = await api.badges();
      if (!fresh.length || ui.moment) return;
      ui.moment = fresh;
      await api.badgesSeen(fresh);
    } catch { /* the celebration is a bonus; stay quiet */ }
  }, 450);
}
export const endMoment = () => { ui.moment = null; };

let toastTimer = 0;
/** A short message; with an action (e.g. undo) it stays a little longer so it can be reached. */
export function toast(text: string, action?: ToastAction) {
  ui.toast = text;
  ui.toastAction = action ?? null;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { ui.toast = ''; ui.toastAction = null; }, action ? 7000 : 2600);
}

function dismissToast() {
  clearTimeout(toastTimer);
  ui.toast = '';
  ui.toastAction = null;
}

/** The toast's button: take the action out first, because dismissing clears it. */
export function runToastAction() {
  const action = ui.toastAction;
  dismissToast();
  void action?.run();
}

/** How people sign in here and whether this browser is signed in. `epoch` changes with every sign-in, so views start fresh. */
export const auth = $state({ ready: false, mode: 'single' as SignInMode, setup: false, codeRequired: false, signedIn: true, ended: false, epoch: 0, oidcLabel: null as string | null });

export async function loadAuth() {
  try {
    const status = await api.authStatus();
    auth.mode = status.mode;
    auth.setup = status.setup_required;
    auth.codeRequired = status.setup_code_required === true;
    auth.signedIn = status.authenticated;
    auth.oidcLabel = status.oidc_label ?? null;
  } catch { /* an older server without the endpoint: the sign-in is not ours to handle */ }
  auth.ready = true;
}

/** Signed in (or the first admin created): load the profile and show the app again where the person was. */
export async function signedIn(_account: Account) {
  auth.signedIn = true;
  auth.ended = false;
  auth.setup = false;
  auth.epoch += 1;
  ui.me = null;
  await loadMe();
}

export async function signOut() {
  try { await api.logout(); } catch { /* the cookie may be gone already */ }
  ui.me = null;
  auth.signedIn = false;
}

// A 401 in local or oidc mode means the session ended (expired, blocked, password changed elsewhere): sign in again.
hooks.unauthorized = () => {
  if ((auth.mode !== 'local' && auth.mode !== 'oidc') || !auth.signedIn) return;
  auth.signedIn = false;
  auth.ended = true;
  ui.me = null;
};

export async function loadMe() {
  try {
    ui.me = await api.me();
    view.current = ui.me.demo_account?.viewing ? 'demo' : 'own';
  } catch { /* the views show their own errors */ }
}

// Which account is shown can change behind the page's back (another tab switched, the switch ended by time, the demo account was
// switched off, the admin right went). The server names the real one in every answer; on a difference, or when it refused a write
// for that reason, the profile is read again, the page is rebuilt for the account that is real now, and a short note says so.
let resyncing = false;
async function resyncView(announce: boolean) {
  if (resyncing) return;
  resyncing = true;
  try {
    const was = view.current;
    const me = await api.me();
    const now = me.demo_account?.viewing ? 'demo' : 'own';
    view.current = now;
    ui.me = me;
    if (was !== now) {
      auth.epoch += 1; // views start fresh for the other account
      ui.add = ui.amount = ui.editor = ui.recipe = ui.workout = null;
      ui.day = ui.today;
    }
    if (announce) toast(t(now === 'demo' ? 'demoViewNow' : 'demoViewOwn'));
  } catch { /* the next answer shows it again */ } finally {
    resyncing = false;
  }
}
hooks.viewChanged = (announce) => { void resyncView(announce); };

// Tabs tell each other about a switch at once (BroadcastChannel, else a storage event); a visible tab also looks when it comes
// back to the front, and while the demo account is shown once a minute (the switch ends by time and by switching off).
const PING = 'mahlwerk.view.ping';
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('mahlwerk-view') : null;
channel?.addEventListener('message', () => { if (view.current) void resyncView(true); });
window.addEventListener('storage', (e) => { if (!channel && e.key === PING && view.current) void resyncView(true); });
const tellTabs = () => {
  if (channel) channel.postMessage('changed');
  else { try { localStorage.setItem(PING, String(Date.now())); } catch { /* no storage: the answers' header tells it */ } }
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && view.current) void resyncView(false); });
window.setInterval(() => { if (view.current === 'demo' && document.visibilityState === 'visible') void resyncView(false); }, 60000);

// The demo account says no (403 with a fixed text): the person sees why, whatever view the action came from.
hooks.blocked = () => toast(t('demoAcctBlocked'));

/** Admin: switch this browser to the demo account (`true`) or back to the own one (`false`). Everything on screen is loaded anew
 * for the other account (views are rebuilt with the epoch) and the day view opens. Returns false when the server refused. */
export async function switchDemo(toDemo: boolean): Promise<boolean> {
  try {
    if (toDemo) await api.enterDemoView(); else await api.leaveDemoView();
  } catch (err) {
    toast(t('demoAcctSwitchFailed', { reason: err instanceof Error ? err.message : 'error' }));
    return false;
  }
  auth.epoch += 1;
  ui.me = null;
  ui.add = ui.amount = ui.editor = ui.recipe = ui.workout = null;
  ui.day = ui.today;
  await loadMe();
  tellTabs();
  location.hash = '#/';
  return true;
}

// Midnight: keep "today" current when the app stayed open overnight.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = today();
  if (now !== ui.today) {
    if (ui.day === ui.today) ui.day = now;
    ui.today = now;
  }
});

// First-run tour of the day view. Remembered per user on the server (`settings.tour_seen`); the public demo has no
// accounts, so there it is remembered per browser.
const TOUR_KEY = 'mahlwerk.tour';
const readTourLocal = () => { try { return localStorage.getItem(TOUR_KEY) === '1'; } catch { return false; } };
const tour = $state({ localSeen: readTourLocal() });
export const tourSeen = () => (DEMO ? tour.localSeen : ui.me?.settings?.tour_seen === true);

async function setTourSeen(seen: boolean) {
  if (DEMO) {
    tour.localSeen = seen;
    try { if (seen) localStorage.setItem(TOUR_KEY, '1'); else localStorage.removeItem(TOUR_KEY); } catch { /* private mode: it shows again next visit */ }
    return;
  }
  if (!ui.me) return;
  ui.me.settings.tour_seen = seen; // at once, so that it does not start twice
  try { ui.me.settings = await api.setSettings({ tour_seen: seen }); } catch { /* not saved: the tour may return on the next start */ }
}
export const markTourSeen = () => setTourSeen(true);
/** Profile: show the tour again the next time the day view opens. */
export const resetTour = () => setTourSeen(false);
