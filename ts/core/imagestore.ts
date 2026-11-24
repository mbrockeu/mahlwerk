// Where recipe pictures live (imagestore.py): the interface core uses; the files themselves are the host's (server/imageStore.ts).
//
// Names come from the content only: `<hash>-<size>.webp` with a 32-character lower-case hex hash and a size key from SIZES;
// nothing a person or a provider wrote ever becomes part of a path.
import type { Processed } from './imageproc.ts';
import { SIZES } from './imageproc.ts';

export const HASH = /^[0-9a-f]{32}$/;
export const validHash = (text: unknown): text is string => typeof text === 'string' && HASH.test(text);
export const validSize = (size: string): boolean => Object.hasOwn(SIZES, size);

/** The pictures cannot be stored; the text is for the person (it never names a path). */
export class StoreError extends Error {}

export interface ImageFiles {
  /** The bytes of one file, or null when the hash or size is not of the exact form or the file is missing. */
  read(digest: string, size: string): Promise<Uint8Array | null>;
  has(digest: string): Promise<boolean>;
  /** Write the three files; a picture that is stored already costs nothing. Throws StoreError (also when the folder is full). */
  put(processed: Processed): Promise<void>;
  delete(digest: string): Promise<void>;
  /** Delete files no food refers to (older than an hour) and old temporary files; at most `limit`. Returns how many. */
  sweep(referenced: Set<string>, limit?: number): Promise<number>;
  sweepDue(): boolean;
}
