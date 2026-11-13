// Rules for names and passwords of the local sign-in mode; the server checks the same limits.
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export type PasswordProblem = 'short' | 'long' | null;

export function passwordProblem(password: string): PasswordProblem {
  const length = [...password].length; // characters, like the server (not UTF-16 units)
  return length < PASSWORD_MIN ? 'short' : length > PASSWORD_MAX ? 'long' : null;
}

/** The server lower-cases and trims names; this is the same form. */
export const normalizeName = (name: string) => name.trim().toLowerCase();
export const nameValid = (name: string) => NAME.test(normalizeName(name));

/** Seconds as short text for a waiting time: "45 s", "3 min". */
export function waitText(seconds: number): string {
  return seconds < 90 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.ceil(seconds / 60)} min`;
}

export const NAME_MAX = 60;
/** The display name as the server stores it: blanks collapsed (the server also trims). */
export const cleanDisplayName = (name: string) => name.trim().split(/\s+/).join(' ');
export const nameProblem = (name: string): 'empty' | 'long' | 'bad' | null => {
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) return 'bad';
  const clean = cleanDisplayName(name);
  return !clean ? 'empty' : [...clean].length > NAME_MAX ? 'long' : null;
};
/** The first character (a whole emoji or letter, not half a surrogate pair) for the round avatars. */
export const initialOf = (name: string | null | undefined, fallback = '') => {
  const first = [...(name || fallback).trim()][0] ?? '';
  return first.toLocaleUpperCase();
};
