// Pictures of recipes (recipeimages.py): link a processed picture to a food, take it away, fetch a provider's picture once.
//
// Three kinds of picture, one rule of precedence:
//   * `own`: a photo a person set. It always wins: a reload from Cookidoo or from the web page never replaces it.
//   * `cookidoo` / `web`: fetched from the provider when the admin switched "store recipe pictures" on for that connector (default off),
//     when a recipe is taken over, when a person asks for "Reload", and for Cookidoo by the catch-up run. A picture that is stored
//     already for the SAME address is not fetched again unless the person explicitly reloads. Never loaded by the browser.
//   * `none`: a person took the provider's picture away; a reload does not bring it back (only "restore" does).
//   * `failed`: the last try to fetch the picture failed; the catch-up leaves such a recipe alone for 7 days.
// The provider's address is controlled by the provider, so it is fetched with the same hardened fetcher as web pages and then decoded in
// a limited child process. A picture that fails for any reason is simply not there: taking over a recipe never fails because of its picture.
import type { Ctx } from './http.ts';
import { ImageRejected, processImage, type ImageRunner, type Processed } from './imageproc.ts';
import { StoreError, type ImageFiles } from './imagestore.ts';
import { checkAddress, FetchFailed, LinkRejected, type Fetcher } from './webrecipes.ts';
import { clearFoodImage, getFood, imageHashes, imageRefs, setFoodImage } from './store/foods.ts';

export const ORIGINS = ['own', 'cookidoo', 'web'];

/** What one person's own photos may take at most: a quarter of the folder, never more than 200 MB (the folder has one limit for all). */
export const PERSON_SHARE_MB = 200;
const personShare = (maxBytes: number): number => Math.min(PERSON_SHARE_MB * 1024 * 1024, Math.floor(maxBytes / 4));

/** Everything that links or unlinks a picture takes this lock, so a file is never deleted between the moment another recipe starts to
 * use it and the moment that is saved. */
class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export class RecipeImages {
  ctx: Ctx;
  files: ImageFiles;
  runner: ImageRunner;
  private lock = new Lock();

  constructor(ctx: Ctx, files: ImageFiles, runner: ImageRunner) { this.ctx = ctx; this.files = files; this.runner = runner; }

  private get db() { return this.ctx.db; }

  /** Process `data` and make it the picture of the food. Throws ImageRejected, StoreError or a RangeError for an unknown food. A
   * provider's picture is dropped (null) when, meanwhile, somebody set an own photo or took the picture away. */
  async attach(foodId: number, data: Uint8Array, origin: string, url: string | null = null, uploader: number | null = null): Promise<string | null> {
    const processed = await processImage(this.runner, data); // outside the lock: this takes a moment
    return this.lock.run(async () => {
      if (origin !== 'own' && !(await this.wants(foodId))) return null; // checked again under the lock: an own photo set during the fetch wins
      if (origin === 'own') await this.checkShare(foodId, processed, uploader);
      await this.files.put(processed);
      const before = await setFoodImage(this.db, foodId, processed.hash, origin, url);
      if (before === false) { // the food is gone: nothing refers to the new files then
        if ((await imageRefs(this.db, processed.hash)) === 0) await this.files.delete(processed.hash);
        throw new UnknownFood(foodId);
      }
      await this.releaseOne(before, processed.hash);
      await this.maybeSweep();
      return processed.hash;
    });
  }

  /** One person cannot fill the folder for everybody: the own photos on the foods the UPLOADER made (a picture taken from a provider
   * counts to nobody) may take `personShare` bytes at most. The uploader is charged, whoever owns the food (also a household food or a
   * food of somebody else the uploader may edit). There is no uploader column, so the pictures counted are those on foods the uploader
   * created. The food's own current picture is not counted (it is replaced), a picture that is among them already costs nothing.
   * Without an uploader (no person behind the call) the owner of the food is charged, and a food without owner is not checked. Throws StoreError. */
  async checkShare(foodId: number, processed: Processed, uploader: number | null = null): Promise<void> {
    const { maxBytes, bytes } = this.files;
    if (!maxBytes || !bytes) return;
    let who = uploader;
    if (who === null) {
      const row = await getFood(this.db, foodId);
      if (!row || row.owner === null) return;
      who = row.owner;
    }
    const hashes = (await this.db.all(
      "SELECT DISTINCT image_hash FROM food WHERE image_origin = 'own' AND image_hash IS NOT NULL AND id != ? "
      + 'AND COALESCE(created_by, (SELECT recipe.created_by FROM recipe WHERE recipe.food_id = food.id)) = ?', [foodId, who])).map((r) => r.image_hash as string);
    if (hashes.includes(processed.hash)) return;
    let used = Object.values(processed.files).reduce((n, b) => n + b.length, 0);
    for (const h of hashes) used += await bytes.call(this.files, h);
    if (used > personShare(maxBytes)) {
      throw new StoreError(`your own recipe pictures take too much space (at most ${Math.floor(personShare(maxBytes) / 1048576)} MB per person): remove some before adding more`);
    }
  }

  /** Take the picture away. `mark`: say that a person did it to a provider's picture (a reload does not bring it back). */
  remove(foodId: number, mark = false): Promise<boolean> {
    return this.lock.run(async () => {
      const row = await getFood(this.db, foodId);
      if (!row) return false;
      const marker = mark && (row.image_origin === 'cookidoo' || row.image_origin === 'web') ? 'none' : null;
      const before = await clearFoodImage(this.db, foodId, marker);
      await this.releaseOne(before === false ? null : before);
      await this.maybeSweep();
      return true;
    });
  }

  /** Lift the "taken away" marker of a provider's picture (the caller then reloads the recipe, which fetches it). False when there is none. */
  restore(foodId: number): Promise<boolean> {
    return this.lock.run(async () => {
      const row = await getFood(this.db, foodId);
      if (!row || row.image_origin !== 'none') return false;
      await clearFoodImage(this.db, foodId, null);
      return true;
    });
  }

  /** After a food was deleted: its picture goes too when nothing else uses it. */
  release(digest: string | null): Promise<void> { return this.lock.run(() => this.releaseOne(digest)); }
  releaseFood(digest: string | null): Promise<void> { return this.release(digest); }

  private async releaseOne(digest: string | null, keep: string | null = null): Promise<void> {
    if (digest && digest !== keep && (await imageRefs(this.db, digest)) === 0) await this.files.delete(digest);
  }

  /** Files nothing refers to (bounded; only old ones): at start-up, after a mass deletion and, at most once a day, on a write. */
  sweep(): Promise<number> { return this.lock.run(async () => this.files.sweep(await imageHashes(this.db))); }

  private async maybeSweep(): Promise<void> {
    if (this.files.sweepDue()) await this.files.sweep(await imageHashes(this.db));
  }

  /** A provider's picture may be stored for this food: nobody set an own one or took it away. */
  async wants(foodId: number): Promise<boolean> {
    const row = await getFood(this.db, foodId);
    return row !== undefined && row.image_origin !== 'own' && row.image_origin !== 'none';
  }

  /** Fetch the provider's picture at `url` and store it for the food. True when there is a picture now. Never throws.
   * Not fetched again (true, no connection) when a picture of the same address is stored and `force` (an explicit reload) is not set.
   * `permit` is asked before any connection (a brake): false means "not now", nothing is marked. */
  async fetchProvider(fetcher: Fetcher, foodId: number, url: string | null, origin: string, opts: { force?: boolean; permit?: () => boolean } = {}): Promise<boolean> {
    if (!url) return false;
    const row = await getFood(this.db, foodId);
    if (!row || row.image_origin === 'own' || row.image_origin === 'none') return false;
    let address: string;
    try { address = checkAddress(url)[0]; } catch (e) { if (e instanceof LinkRejected) return false; throw e; }
    if (!opts.force && row.image_hash && row.image_url === address) return true;
    if (opts.permit && !opts.permit()) return Boolean(row.image_hash);
    try {
      const page = await fetcher.fetchImage(address);
      return (await this.attach(foodId, page.data, origin, address)) !== null;
    } catch (e) {
      if (e instanceof FetchFailed) console.info('recipe picture not fetched:', e.kind);
      else if (e instanceof ImageRejected) console.info('recipe picture refused:', e.kind);
      else if (e instanceof StoreError) console.warn('recipe pictures:', e.message);
      else if (e instanceof UnknownFood) return false;
      else console.warn('recipe picture failed', e instanceof Error ? e.name : 'error'); // a picture must never break taking a recipe over
    }
    if (!row.image_hash) await clearFoodImage(this.db, foodId, 'failed'); // remember the failure (the catch-up skips such a recipe for a week); a picture it has stays
    return Boolean(row.image_hash);
  }
}

export class UnknownFood extends Error {
  constructor(foodId: number) { super(`unknown food ${foodId}`); }
}
