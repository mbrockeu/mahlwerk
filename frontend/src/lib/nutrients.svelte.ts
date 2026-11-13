// Directory of the additional nutrients (GET /nutrients) and helpers to show them.
import { api } from './api';
import { fmt, t } from './i18n';
import type { NutrientGroup, NutrientInfo } from './types';

/** Order of the groups in the product editor. */
export const GROUP_ORDER: NutrientGroup[] = ['fat', 'carb', 'mineral', 'vitamin', 'other'];

export const directory = $state({ list: [] as NutrientInfo[] });

let pending: Promise<void> | null = null;
/** Load the directory once; it only changes with a server update. */
export function ensureNutrients(): Promise<void> {
  pending ??= api.nutrients().then(
    (list) => { directory.list = list; },
    () => { pending = null; },
  );
  return pending;
}

export const nutrientName = (key: string) => t(`n_${key}`);

/** Amount with a precision that suits its size: 0.37 mg, 8.2 µg, 129 mg. */
export function fmtAmount(value: number, unit: string): string {
  const digits = value >= 100 ? 0 : value >= 1 ? 1 : value >= 0.1 ? 2 : 3;
  return `${fmt(value, digits)} ${unit}`;
}

/** The three tabs of the evaluation card: vitamins, minerals and everything else. */
export type MicroTab = 'vitamin' | 'mineral' | 'more';
export const microTab = (group: NutrientGroup): MicroTab => (group === 'vitamin' || group === 'mineral' ? group : 'more');

/** Below this coverage a value is shown quietly: it says little and must never look like a deficiency. */
export const QUIET_COVERAGE = 0.2;
