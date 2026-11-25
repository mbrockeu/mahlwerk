// Who may change what is shared (ownership.py): members of the household (and admins) change everything, a guest only
// what they made. The owner of a food, recipe or group is the user id in `created_by`; null means the household owns it.
import { HttpError, type User } from './http.ts';

export const HOUSEHOLD_ONLY = 'this belongs to the household: only members of the household may change it';
export const NOT_YOURS = 'this was made by somebody else: guests may change only what they made themselves';

export const isHousehold = (user: User): boolean => Boolean(user.household);

export const canEdit = (user: User, owner: number | null | undefined): boolean =>
  isHousehold(user) || (owner != null && owner === user.id);

/** 403 unless the user may change something owned by `owner`. */
export function needEdit(user: User, owner: number | null | undefined): void {
  if (!canEdit(user, owner)) throw new HttpError(403, owner != null ? NOT_YOURS : HOUSEHOLD_ONLY);
}

export function needHousehold(user: User, what = 'this'): void {
  if (!isHousehold(user)) throw new HttpError(403, `${what} is for members of the household only`);
}
