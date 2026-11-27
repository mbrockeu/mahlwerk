// Outgoing webhooks of the signed-in user (routes/webhooks.py; the delivery is in webhooks.ts).
import { featureOn, hostAllowed } from '../features.ts';
import { HttpError, parse, pathInt, route, type Req, type Route } from '../http.ts';
import { webhookIn, webhookPatch } from '../models/webhook.ts';
import {
  createWebhook, deleteWebhook, getWebhook, listDeliveries, listWebhooks, updateWebhook,
} from '../store/webhooks.ts';
import { checkUrl, dispatcher, hostOf, PING, target } from '../webhooks.ts';

const MAX_HOOKS = 20;

/** The dependencies of the router: a caller of the household who signed in the normal way (an access token is refused, a guest
 * too), and the switch. */
async function need(req: Req): Promise<void> {
  if (req.user!.via_token) throw new HttpError(403, 'not available with an access token');
  if (!req.user!.household) throw new HttpError(403, 'webhooks are only for members of the household');
  if (!(await featureOn(req.ctx, 'webhooks.enabled'))) throw new HttpError(404, 'webhooks are switched off');
}

async function checkTarget(req: Req, url: string): Promise<void> {
  const problem = checkUrl(url);
  if (problem !== null) throw new HttpError(422, problem);
  if (!(await hostAllowed(req.ctx, hostOf(url)))) throw new HttpError(422, 'this host is not on the list of allowed webhook targets');
  // one answer for "does not resolve", "internal" and everything else: no oracle for the inside of the network
  if ((await target(req.ctx, url, hostOf(url))) === false) {
    throw new HttpError(422, 'target not allowed: it must be a public address, or an admin lists its host in the allowed webhook hosts');
  }
}

async function own(req: Req, hookId: number) {
  const hook = await getWebhook(req.ctx.db, req.user!.id, hookId);
  if (!hook) throw new HttpError(404, 'unknown webhook');
  return hook;
}

const guarded = (fn: (req: Req) => Promise<any>) => async (req: Req) => { await need(req); return fn(req); };

function secret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'whsec_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const routes: Route[] = [
  route('GET', '/api/v1/me/webhooks', guarded((req) => listWebhooks(req.ctx.db, req.user!.id))),

  // Register a target. The signing secret is generated here and shown only in this response.
  route('POST', '/api/v1/me/webhooks', guarded(async (req) => {
    const body = parse(webhookIn, req.body);
    await checkTarget(req, body.url);
    const { db } = req.ctx;
    const user = req.user!;
    if ((await listWebhooks(db, user.id)).length >= MAX_HOOKS) throw new HttpError(409, `at most ${MAX_HOOKS} webhooks`);
    const key = secret();
    const hook = await createWebhook(db, user.id, body.name, body.url, key, [...new Set(body.events)]);
    if (!body.enabled) {
      await updateWebhook(db, user.id, hook.id, { enabled: false });
      hook.enabled = false;
    }
    return { ...hook, secret: key };
  }), { status: 201 }),

  route('PATCH', '/api/v1/me/webhooks/{hook_id}', guarded(async (req) => {
    const hookId = pathInt(req, 'hook_id');
    const body = parse(webhookPatch, req.body);
    await own(req, hookId);
    const changes: Record<string, unknown> = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== undefined)); // exclude_none
    if ('url' in changes) await checkTarget(req, changes.url as string);
    if ('events' in changes) changes.events = [...new Set(changes.events as string[])];
    await updateWebhook(req.ctx.db, req.user!.id, hookId, changes);
    return own(req, hookId);
  })),

  route('DELETE', '/api/v1/me/webhooks/{hook_id}', guarded(async (req) => {
    if (!(await deleteWebhook(req.ctx.db, req.user!.id, pathInt(req, 'hook_id')))) throw new HttpError(404, 'unknown webhook');
    return undefined;
  }), { status: 204 }),

  // Send a `ping` to this hook (whatever events it listens to). The result shows up in the deliveries.
  route('POST', '/api/v1/me/webhooks/{hook_id}/test', guarded(async (req) => {
    const hook = await own(req, pathInt(req, 'hook_id'));
    dispatcher(req.ctx).publish(req.user!.id, req.user!.username, PING, { hook: hook.name, message: 'Test delivery from Mahlwerk' }, hook.id);
    return { queued: true };
  }), { status: 202 }),

  // The last 20 deliveries of this hook, newest first.
  route('GET', '/api/v1/me/webhooks/{hook_id}/deliveries', guarded(async (req) => {
    const hook = await own(req, pathInt(req, 'hook_id'));
    return listDeliveries(req.ctx.db, hook.id);
  })),
];
