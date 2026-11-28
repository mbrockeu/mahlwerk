// The share of the picture folder one person's own photos may take (RecipeImages.checkShare).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { RecipeImages } from '../core/recipeImages.ts';
import { StoreError, type ImageFiles } from '../core/imagestore.ts';
import type { Processed } from '../core/imageproc.ts';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) await w.close(); });

const MB = 1024 * 1024;
const hash = (n: number) => n.toString(16).padStart(32, '0');
const pic = (n: number, bytes: number): Processed => ({ hash: hash(n), width: 1, height: 1, files: { l: new Uint8Array(bytes), m: new Uint8Array(0), s: new Uint8Array(0) } });

test('one person cannot take more than a quarter of the folder with own photos; provider and household pictures count to nobody', async () => {
  const w = await makeWorld({ on: false });
  worlds.push(w);
  const { db } = w.ctx;
  const sizes = new Map<string, number>();
  const files = { maxBytes: 40 * MB, bytes: async (d: string) => sizes.get(d) ?? 0 } as unknown as ImageFiles; // share: 10 MB
  const images = new RecipeImages(w.ctx, files, { run: async () => new Uint8Array(0) });
  const user = async (name: string) => (await db.run('INSERT INTO user (username, display_name, created_at) VALUES (?, ?, 1)', [name, name])).lastId;
  const [ann, bob] = [await user('ann'), await user('bob')];
  const food = async (by: number | null, h: number | null, origin: string | null) =>
    (await db.run("INSERT INTO food (source, found, data, fetched_at, created_by, image_hash, image_origin) VALUES ('recipe', 1, '{}', 1, ?, ?, ?)", [by, h === null ? null : hash(h), origin])).lastId;
  const own = await food(ann, 1, 'own'); sizes.set(hash(1), 6 * MB);
  const second = await food(ann, null, null);
  await food(bob, 2, 'own'); sizes.set(hash(2), 9 * MB); // another person's pictures do not count
  await food(ann, 3, 'web'); sizes.set(hash(3), 50 * MB); // a provider picture counts to nobody
  await food(null, 4, 'own'); sizes.set(hash(4), 50 * MB); // the household's
  await images.checkShare(second, pic(10, 3 * MB), ann); // 6 + 3 MB: fits
  await assert.rejects(images.checkShare(second, pic(11, 5 * MB), ann), (e: unknown) => e instanceof StoreError && /too much space/.test(e.message)); // 6 + 5 MB
  await images.checkShare(own, pic(11, 9 * MB), ann); // replacing the picture of the same recipe frees its old one
  await images.checkShare(second, pic(1, 9 * MB), ann); // a picture that is among them already costs nothing
  const third = await food(bob, null, null);
  await images.checkShare(third, pic(12, MB), bob); // bob: 9 + 1 MB
  await assert.rejects(images.checkShare(third, pic(13, 2 * MB), bob), StoreError); // 9 + 2 MB
  // the uploader is charged, also for a household food (no owner) and for a food of somebody else
  const household = await food(null, null, null);
  await assert.rejects(images.checkShare(household, pic(14, 5 * MB), ann), StoreError); // ann: 6 + 5 MB
  await images.checkShare(household, pic(15, 3 * MB), ann); // 6 + 3 MB
  await assert.rejects(images.checkShare(third, pic(16, 5 * MB), ann), StoreError); // bob's food, ann uploads: ann is charged
  await images.checkShare(household, pic(17, 50 * MB)); // no uploader and no owner: not checked
});
