// What the Node host puts into `ctx.services` (core never imports these): outgoing HTTP, the catalogue files, the pictures (folder and
// child process). The test host uses the same pieces but a different outgoing HTTP (see testhost.ts).
import type { Ctx } from '../core/http.ts';
import type { Outgoing } from '../core/outgoing.ts';
import type { FoodLinks } from '../core/foodView.ts';
import { installCookidoo } from '../core/cookidooService.ts';
import { yazioOf } from '../core/routes/yazio.ts';
import { RecipeImages } from '../core/recipeImages.ts';
import { hostLabel, safeLink } from '../core/webrecipes.ts';
import { nodeCatalog } from './catalogFiles.ts';
import { CatalogRefresh } from './jobs.ts';
import { nodeImageRunner } from './imageRunner.ts';
import { imageFolder, maxBytesFromEnv, nodeImageStore } from './imageStore.ts';

// The links of the recipe sources (one object per app: the Cookidoo part reads that app's environment, see installCookidoo).
const foodLinks = (): FoodLinks => ({ cookidooUrl: () => null, webLink: safeLink, hostLabel });

export function addServices(ctx: Ctx, dbPath: string, out: Outgoing): void {
  const clock = () => ctx.now();
  const runner = nodeImageRunner();
  const catalog = nodeCatalog(ctx.env, dbPath);
  Object.assign(ctx.services, {
    out,
    catalog,
    refresh: new CatalogRefresh(ctx, catalog),
    foodLinks: foodLinks(),
    imageRunner: runner,
    images: new RecipeImages(ctx, nodeImageStore(imageFolder(dbPath), maxBytesFromEnv(ctx.env), clock), runner),
  });
  yazioOf(ctx); // the staging area and the runs of the Yazio import; registers what ends with a session or a switch
  installCookidoo(ctx); // after the pictures: the runs use them
}
