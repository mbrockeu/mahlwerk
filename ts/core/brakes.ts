// The per-app state of the web and picture features (main.py: web_brake, web_cache, image_brake, upload_brake, web_fetcher), made at the
// first use and kept in `ctx.services`. The host may put its own object under the same key (the tests do for the clock).
import type { Ctx } from './http.ts';
import { Brake, Cache, Fetcher } from './webrecipes.ts';
import { VERSION } from './version.ts';

const make = {
  web: (ctx: Ctx) => new Brake(() => ctx.now()),
  image: (ctx: Ctx) => new Brake(() => ctx.now(), 30, 120), // fetches of Cookidoo pictures
  upload: (ctx: Ctx) => new Brake(() => ctx.now(), 20, 200), // own photos
} as const;

export function brake(ctx: Ctx, name: keyof typeof make): Brake {
  const key = `${name}Brake`;
  return (ctx.services[key] ??= make[name](ctx)) as Brake;
}

export const webCache = (ctx: Ctx): Cache => (ctx.services.webCache ??= new Cache(() => ctx.now())) as Cache;

export function webFetcher(ctx: Ctx): Fetcher {
  const contact = ctx.env.MAHLWERK_CONTACT ?? 'no-contact-configured';
  return (ctx.services.webFetcher ??= new Fetcher(ctx, `Mahlwerk/${VERSION} (${contact})`)) as Fetcher;
}
