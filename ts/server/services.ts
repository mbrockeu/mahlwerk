// What the Node host puts into `ctx.services` (core never imports these): outgoing HTTP, the catalogue files, the pictures (folder and
// child process). The test host uses the same pieces but a different outgoing HTTP (see testhost.ts).
import type { Ctx } from '../core/http.ts';
import type { Outgoing } from '../core/outgoing.ts';
import { RecipeImages } from '../core/recipeImages.ts';
import { nodeCatalog } from './catalogFiles.ts';
import { nodeImageRunner } from './imageRunner.ts';
import { imageFolder, maxBytesFromEnv, nodeImageStore } from './imageStore.ts';

export function addServices(ctx: Ctx, dbPath: string, out: Outgoing): void {
  const clock = () => ctx.now();
  const runner = nodeImageRunner();
  Object.assign(ctx.services, {
    out,
    catalog: nodeCatalog(ctx.env, dbPath),
    imageRunner: runner,
    images: new RecipeImages(ctx, nodeImageStore(imageFolder(dbPath), maxBytesFromEnv(ctx.env), clock), runner),
  });
}
