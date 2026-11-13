// Pictures of recipes. The files are on the server (api/v1/images/<hash>/<size>); the browser never loads a picture from anywhere else
// (the content security policy forbids it), and never decides on its own what a picture is: the server says `food.image`.
import type { Food, FoodImage } from './types';

export type ImageSize = 'l' | 'm' | 's';

/** Only the mock and the demo fill this: hash -> a drawn stand-in (a data: address), so that no server is needed to see the look. */
export const imageRegistry: Record<string, string> = {};

/** Relative, so that the app works below any path prefix; the hash is the content hash, so the address never changes for a picture. */
export const imageUrl = (hash: string, size: ImageSize): string => imageRegistry[hash] ?? `api/v1/images/${hash}/${size}`;

/** "Image: Cookidoo" / "Image: recipes.example.org" for a picture taken over from a provider, else null. */
export const imageCredit = (image: FoodImage | null | undefined): string | null => (image && image.origin !== 'own' ? image.credit : null);

export const hasImage = (food: Pick<Food, 'image'>): boolean => !!food.image?.hash;

/** The first letter to show where there is no picture (a whole character, so an emoji or a letter with a mark is not cut in half). */
export const initial = (name: string | null | undefined): string => {
  const first = [...(name ?? '').trim()][0] ?? '';
  return first.toLocaleUpperCase();
};
