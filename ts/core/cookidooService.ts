// What ties the Cookidoo connector to the host: the hub and the runs (one each per app, made at first use and kept in `ctx.services`),
// the vault, and the hooks other parts call (`userEnded`, `connectorOff`, the admin card, the food links).
//
// The host may put its own client factory under `ctx.services.cookidooFactory` (the tests do: a stand-in client); without it the real
// client is used, on top of `ctx.services.out`.
import { brake, webFetcher } from './brakes.ts';
import { Hub, MESSAGES, Settings, Access, SHARED, recipeUrl, type CookidooClient } from './cookidoo.ts';
import { BulkRuns, type ImagesPort } from './cookidooBulk.ts';
import { LibraryClient } from './cookidooClient.ts';
import { featureOn } from './features.ts';
import type { Ctx } from './http.ts';
import { outgoing } from './outgoing.ts';
import type { FoodLinks } from './foodView.ts';
import { HOUSEHOLD, Vault, maskEmail } from './vault.ts';

export const SECRET_NAME = 'cookidoo';

export function cookidooHub(ctx: Ctx): Hub {
  return (ctx.services.cookidoo ??= new Hub({
    factory: (settings: Settings): CookidooClient => (ctx.services.cookidooFactory as ((s: Settings) => CookidooClient) | undefined)?.(settings) ?? new LibraryClient(settings, outgoing(ctx)),
    clock: () => ctx.now(),
  })) as Hub;
}

export function cookidooRuns(ctx: Ctx): BulkRuns {
  return (ctx.services.cookidooRuns ??= new BulkRuns({
    hub: cookidooHub(ctx), db: ctx.db, clock: () => ctx.now(),
    enabled: () => featureOn(ctx, 'cookidoo.enabled'), imagesOn: () => featureOn(ctx, 'cookidoo.images'),
    images: ctx.services.images as ImagesPort | undefined, fetcher: webFetcher(ctx),
  })) as BulkRuns;
}

export const vaultOf = (ctx: Ctx): Vault => (ctx.services.vault ??= new Vault(ctx)) as Vault;
export const imageBrake = (ctx: Ctx) => brake(ctx, 'image');

/** The account stored for `userId` (`stored`, `unreadable`, `none`). */
async function storedAccess(ctx: Ctx, userId: number, key: string, scope: 'shared' | 'own'): Promise<[Access | null, string]> {
  const vault = vaultOf(ctx);
  const state = await vault.state(userId, SECRET_NAME);
  if (state !== 'stored') return [null, state];
  const settings = Settings.fromStored(await vault.get(userId, SECRET_NAME));
  return settings ? [new Access(key, settings, scope), 'stored'] : [null, 'unreadable'];
}

/** The household account and where it comes from (`env`, `stored`, `unreadable`, `none`). The environment wins. */
export async function sharedAccess(ctx: Ctx): Promise<[Access | null, string]> {
  const env = Settings.fromEnv(ctx.env);
  if (env !== null) return [new Access(SHARED, env, 'shared'), 'env'];
  return storedAccess(ctx, HOUSEHOLD, SHARED, 'shared');
}

/** The user's own account (`stored`, `unreadable`, `none`), whether or not own accounts are allowed right now. */
export const ownAccess = (ctx: Ctx, userId: number): Promise<[Access | null, string]> => storedAccess(ctx, userId, `user:${userId}`, 'own');

/** The admin card of the connector (what the card says beyond the switch). */
export async function accountOut(ctx: Ctx, userId: number, key: string, env: boolean, allowed: boolean, admin: boolean) {
  const vault = vaultOf(ctx);
  const hub = cookidooHub(ctx);
  let settings: Settings | null;
  let source: string;
  let editable: boolean;
  if (env) {
    settings = Settings.fromEnv(ctx.env);
    [source, editable] = ['env', false];
  } else {
    const state = await vault.state(userId, SECRET_NAME);
    settings = state === 'stored' ? Settings.fromStored(await vault.get(userId, SECRET_NAME)) : null;
    source = settings || state !== 'stored' ? state : 'unreadable';
    editable = allowed;
  }
  return {
    source, email: settings ? maskEmail(settings.email) : null, country: settings ? settings.country : null, language: settings ? settings.language : null,
    editable, allowed, key: admin ? await vault.keyStatus() : null, error: MESSAGES[hub.errorOf(key) ?? ''] ?? null,
  };
}

/** Hooks of the host: composed with what is already there (other packages fill the same slots), so call this after theirs or before. */
export function installCookidoo(ctx: Ctx): void {
  const s = ctx.services;
  const previousEnded = s.userEnded as ((id: number) => Promise<void> | void) | undefined;
  // a person's own Cookidoo sign-in is not kept in memory after they sign out, are blocked or lose access (their runs end with it)
  s.userEnded = async (userId: number) => { await previousEnded?.(userId); await cookidooHub(ctx).forget(`user:${userId}`); };

  const previousOff = s.connectorOff as ((u: Record<string, unknown>) => Promise<void> | void) | undefined;
  s.connectorOff = async (updates: Record<string, unknown>) => {
    await previousOff?.(updates);
    const runs = cookidooRuns(ctx);
    if (updates['cookidoo.enabled'] === false) runs.cancelAll('off'); // a run that takes over many recipes ends (what it saved stays)
    if (updates['cookidoo.images'] === false) runs.cancelPictureRuns('off'); // a picture catch-up ends; a run that takes recipes over goes on without pictures
    if (updates['cookidoo.personal'] === false) runs.cancelOwnRuns('account'); // runs on people's own accounts end, the shared account's run goes on
  };

  s.cards = {
    ...(s.cards as object | undefined),
    cookidoo: async () => {
      const hub = cookidooHub(ctx);
      const env = Settings.fromEnv(ctx.env) !== null;
      return {
        status: hub.status(await featureOn(ctx, 'cookidoo.enabled'), (await sharedAccess(ctx))[0]),
        info: { error: MESSAGES[hub.lastError ?? ''] ?? null, shared_account: true, account: await accountOut(ctx, HOUSEHOLD, SHARED, env, true, true),
          env: 'MAHLWERK_COOKIDOO_EMAIL, MAHLWERK_COOKIDOO_PASSWORD' },
      };
    },
  };

  const links = (s.foodLinks ??= {}) as Partial<FoodLinks>;
  links.cookidooUrl = (externalId, region) => recipeUrl(externalId, ctx.env, region);
}
