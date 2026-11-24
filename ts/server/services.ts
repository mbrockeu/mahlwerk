// What the Node host puts into `ctx.services` (core never imports these): outgoing HTTP, the catalogue files.
// The test host uses the same pieces but a different outgoing HTTP (see testhost.ts).
import type { Outgoing } from '../core/outgoing.ts';
import { nodeCatalog } from './catalogFiles.ts';

export function makeServices(env: Record<string, string | undefined>, dbPath: string, out: Outgoing): Record<string, unknown> {
  return { out, catalog: nodeCatalog(env, dbPath) };
}
