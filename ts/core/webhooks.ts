// Outgoing webhooks (webhooks.py): events of a user are POSTed to the URLs the user registered.
//
// Delivery never happens in the request path. A request only puts a small job on a queue (`Dispatcher.publish`); the dispatcher
// looks up the user's hooks and delivers to each, at most POOL at a time. A delivery tries up to three times (with a wait in
// between), never follows redirects and gives up after a timeout of five seconds per try. A broken or slow hook therefore can
// neither slow down nor fail a request. Each delivery is logged (`webhook_delivery`, the last 20 per hook are kept). The body is
// signed with the hook's secret: header `X-Mahlwerk-Signature: sha256=<hex HMAC-SHA256 of the raw body>`.
import { configOf, effectiveHousehold } from './auth.ts';
import { featureOn, hostAllowed, hostListed } from './features.ts';
import type { Ctx, Req, User } from './http.ts';
import { pickAddress, sameHostEverywhere } from './netguard.ts';
import { outgoing } from './outgoing.ts';
import {
  getWebhook, hooksForEvent, pruneDeliveries, startDelivery, updateDelivery, webhookById, type Hook,
} from './store/webhooks.ts';
import { urlsplit } from './urlsplit.ts';
import { blockedHosts, isBlocked, ownHosts } from './webrecipes.ts';

export const PING = 'ping';
const TIMEOUT = 5.0;
const MAX_ATTEMPTS = 3;
const BACKOFF = [2.0, 10.0]; // seconds to wait before the second and the third try
const POOL = 4;
/** Deliveries of one person that may wait for a free place; beyond that new ones are dropped (a backlog that a slow receiver
 * cannot work off in reasonable time anyway). The places are handed out in turns between people, so one person's backlog never
 * holds up the others. */
export const MAX_WAITING_PER_PERSON = 500;
const MAX_URL = 500;
const MAX_ANSWER = 64 * 1024; // the receiver's answer is not used (only its status); a longer one counts as a failed try

export async function sign(secret: string, body: Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, body as BufferSource));
  return 'sha256=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Why the URL cannot be a webhook target, or null when it is fine (http or https with a host, no credentials). */
export function checkUrl(url: string): string | null {
  if ([...url].length > MAX_URL) return 'url is too long';
  let parts;
  try {
    parts = urlsplit(url);
  } catch {
    return 'not a valid url';
  }
  if (parts.scheme !== 'http' && parts.scheme !== 'https') return 'url must start with http:// or https://';
  if (!parts.hostname) return 'url needs a host';
  if (parts.username || parts.password) return 'url must not contain a user name or password';
  return null;
}

export function hostOf(url: string): string | null {
  try { return urlsplit(url).hostname; } catch { return null; }
}

/** The address to connect to, or false when the target may not be called. Checked at EVERY delivery: a hook made before this
 * check existed, or whose DNS name now points inside, is refused too. The server's own names (as for web recipes: its public
 * URL, MAHLWERK_ALLOWED_HOSTS and their subdomains) are refused even when the admin lists them: they reach the server and the
 * gateway in front of it from the outside. */
export async function target(ctx: Ctx, url: string, host: string | null): Promise<string | false> {
  if (checkUrl(url) || !(await hostAllowed(ctx, host)) || !sameHostEverywhere(url)) return false;
  if (isBlocked(host!, blockedHosts(ctx.env))) return false;
  try {
    const parts = urlsplit(url);
    const port = parts.port || (url.toLowerCase().startsWith('https') ? 443 : 80);
    const listed = await hostListed(ctx, host);
    return await pickAddress(ctx, host!, port, listed, listed ? [] : ownHosts(ctx.env));
  } catch {
    return false; // TargetNotAllowed, or a port that is no number (ValueError in Python)
  }
}

interface Job { user_id: number; username: string; event: string; data: unknown; at: number; hook_id: number | null }

export class Dispatcher {
  ctx: Ctx;
  timeout = TIMEOUT;
  backoff = BACKOFF;
  private stopped = false;
  private open = 0; // jobs and deliveries not finished yet
  private idle: (() => void)[] = [];
  private chain: Promise<void> = Promise.resolve();
  private running = 0;
  private waiting = new Map<number, (() => void)[]>(); // per person, in order
  private turns: number[] = []; // people with waiting deliveries, in the order they get the next free place
  private dropped = new Map<number, number>(); // per person since the last log line
  private wake: (() => void)[] = [];

  constructor(ctx: Ctx) { this.ctx = ctx; }

  /** Queue an event. Cheap and safe: it never throws and never waits for the network. */
  publish(userId: number, username: string, event: string, data: unknown, hookId: number | null = null): void {
    if (this.stopped) return;
    try {
      const job: Job = { user_id: userId, username, event, data, at: Math.floor(Date.now() / 1000), hook_id: hookId };
      this.begin();
      this.chain = this.chain.then(() => this.fanOut(job)).catch((e) => console.error('webhook job failed', e)).finally(() => this.done());
    } catch (e) {
      console.error('could not queue webhook event', e);
    }
  }

  private begin(): void { this.open++; }
  private done(): void {
    this.open--;
    if (this.open <= 0) for (const f of this.idle.splice(0)) f();
  }

  /** Resolves when every queued event is delivered (or given up). */
  waitIdle(timeoutSeconds = 10): Promise<boolean> {
    if (this.open <= 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutSeconds * 1000);
      this.idle.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  /** Stop cleanly: no new work, waits end at once, running sends finish or time out. */
  stop(): void {
    this.stopped = true;
    for (const f of this.wake.splice(0)) f();
  }

  private async fanOut(job: Job): Promise<void> {
    const { db } = this.ctx;
    if (!(await featureOn(this.ctx, 'webhooks.enabled'))) return;
    // guests have no webhooks: hooks they made before they became guests stay quiet
    const owner = await db.get<{ household: number; local_admin: number }>('SELECT household, local_admin FROM user WHERE id = ?', [job.user_id]);
    if (!owner || !effectiveHousehold(configOf(this.ctx), Boolean(owner.household), Boolean(owner.local_admin))) return;
    let hooks: Hook[];
    if (job.hook_id !== null) {
      const hook = await webhookById(db, job.hook_id);
      hooks = hook && (await getWebhook(db, job.user_id, hook.id)) ? [hook] : [];
    } else hooks = await hooksForEvent(db, job.user_id, job.event);
    for (const hook of hooks) {
      if ((this.waiting.get(job.user_id)?.length ?? 0) >= MAX_WAITING_PER_PERSON) { this.drop(job.user_id); continue; }
      const deliveryId = await startDelivery(db, hook.id, job.event);
      this.begin();
      void this.slot(job.user_id).then(() => this.deliver(hook, deliveryId, job)).finally(() => { this.release(); this.done(); });
    }
  }

  /** Deliveries waiting for a place, per person (for tests and the drop rule). */
  waitingFor(userId: number): number { return this.waiting.get(userId)?.length ?? 0; }

  private drop(userId: number): void {
    const n = (this.dropped.get(userId) ?? 0) + 1;
    this.dropped.set(userId, n);
    if (n !== 1) return;
    const t: unknown = setTimeout(() => {
      console.warn(`webhooks: ${this.dropped.get(userId)} deliveries of user ${userId} dropped, too many were waiting`);
      this.dropped.delete(userId);
    }, 60_000);
    (t as { unref?: () => void }).unref?.(); // Node: do not keep the process alive for a log line (the app host gets a number)
  }

  /** A place for one of this person's deliveries; a retry (`first`) goes to the front of the person's own queue, so its backoff
   * stays what it says even when the person has a backlog. */
  private async slot(userId: number, first = false): Promise<void> {
    if (this.running < POOL) { this.running++; return; }
    await new Promise<void>((r) => { // the releasing delivery hands its place over
      const queue = this.waiting.get(userId);
      if (queue) { if (first) queue.unshift(r); else queue.push(r); }
      else { this.waiting.set(userId, [r]); this.turns.push(userId); }
    });
  }
  private release(): void {
    const userId = this.turns.shift();
    if (userId === undefined) { this.running--; return; }
    const queue = this.waiting.get(userId)!;
    const next = queue.shift()!;
    if (queue.length) this.turns.push(userId); else this.waiting.delete(userId);
    next();
  }

  private sleep(seconds: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve(true);
      const t = setTimeout(() => resolve(false), seconds * 1000);
      this.wake.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  /** The hook as it is NOW, or why this delivery must not go out: the hook was removed or changed (disabled, no longer listening
   * to the event), webhooks were switched off, or the owner is no guest-free household member any more. A hook that was asked
   * for by id (the ping) needs neither to be enabled nor to listen to the event, as in `fanOut`. A failed lookup gives up too. */
  private async current(hook: Hook, job: Job): Promise<Hook | string> {
    try {
      const { db } = this.ctx;
      if (!(await featureOn(this.ctx, 'webhooks.enabled'))) return 'webhooks switched off';
      const owner = await db.get<{ household: number; local_admin: number }>('SELECT household, local_admin FROM user WHERE id = ?', [job.user_id]);
      if (!owner || !effectiveHousehold(configOf(this.ctx), Boolean(owner.household), Boolean(owner.local_admin))) return 'hook changed (owner is no household member)';
      const live = await getWebhook(db, job.user_id, hook.id, true);
      if (!live) return 'hook removed';
      if (job.hook_id === null && (!live.enabled || !live.events.includes(job.event))) return 'hook changed';
      return live;
    } catch (e) {
      console.error('webhook re-check failed', e);
      return 'hook changed (could not be checked)';
    }
  }

  private async deliver(hook: Hook, deliveryId: number, job: Job): Promise<void> {
    const { db } = this.ctx;
    let status: number | null = null;
    let error: string | null = null;
    let attempts = 0;
    try {
      // json.dumps(separators=(",", ":"), ensure_ascii=False, allow_nan=False)
      const body = new TextEncoder().encode(JSON.stringify({
        event: job.event, occurred_at: new Date(job.at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        user: { username: job.username }, data: job.data,
      }, (_k, v) => { if (typeof v === 'number' && !Number.isFinite(v)) throw new RangeError('NaN'); return v; }));
      let checkedUrl: string | null = null; // the URL `address` was resolved for
      let address: string | false = false;
      while (attempts < MAX_ATTEMPTS && !this.stopped) {
        // The hook is read again right before EVERY attempt (the first one and each retry, once the place is won): what the owner
        // or the admin changed while the delivery waited counts, the snapshot from fan-out time does not.
        const live = await this.current(hook, job);
        if (typeof live === 'string') { error = live; break; }
        if (live.url !== checkedUrl) {
          checkedUrl = live.url;
          address = await target(this.ctx, live.url, hostOf(live.url));
        }
        if (address === false) { error = 'target not allowed'; break; }
        attempts++;
        status = null;
        error = null;
        try {
          const headers = {
            'Content-Type': 'application/json', 'User-Agent': 'Mahlwerk-Webhook', 'X-Mahlwerk-Event': job.event,
            'X-Mahlwerk-Delivery': String(deliveryId), 'X-Mahlwerk-Signature': await sign(live.secret!, body),
          };
          // one POST; redirects are not followed, environment proxies are not used; the connection goes to the address that was
          // checked, Host and TLS keep the name of the URL
          status = (await outgoing(this.ctx).fetch('webhook', { method: 'POST', url: live.url, headers, body, timeout: this.timeout, address, maxBytes: MAX_ANSWER })).status;
        } catch {
          error = 'delivery failed'; // one text for every network problem: it must not tell a closed port from a filtered one or a timeout
        }
        if (status !== null) {
          if (status >= 200 && status < 300) break;
          error = `HTTP ${status}`;
          if (status < 500 && status !== 429) break; // the receiver said no; asking again will not help
        }
        await updateDelivery(db, deliveryId, attempts, status, error, false);
        if (attempts < MAX_ATTEMPTS) {
          // the wait before the next try gives the place to others; the next try then waits for this person's next turn
          this.release();
          const stop = await this.sleep(this.backoff[Math.min(attempts - 1, this.backoff.length - 1)]!);
          await this.slot(job.user_id, true);
          if (stop) break;
        }
      }
    } catch (e) {
      console.error('webhook delivery failed', e);
      error = error ?? 'delivery failed';
    } finally {
      try {
        const ok = status !== null && status >= 200 && status < 300;
        await updateDelivery(db, deliveryId, attempts, status, ok ? null : error, true);
        await pruneDeliveries(db, hook.id);
      } catch (e) {
        console.error('could not log webhook delivery', e);
      }
    }
  }
}

/** The dispatcher of this app (made at the first event). */
export function dispatcher(ctx: Ctx): Dispatcher {
  return (ctx.services.webhooks ??= new Dispatcher(ctx)) as Dispatcher;
}

/** Whether an `event` of `user` would reach a hook now (what `fanOut` checks: not the demo account, webhooks on, an enabled hook
 * that takes the event). The routes ask before they build a costly payload; an error counts as yes (the payload is built as before). */
export async function hooksWanted(req: Req, user: User, event: string): Promise<boolean> {
  if (user.is_demo) return false;
  try {
    return (await featureOn(req.ctx, 'webhooks.enabled')) && (await hooksForEvent(req.ctx.db, user.id, event)).length > 0;
  } catch {
    return true;
  }
}

/** Called by the routes after a change. Never throws. The demo account never sends anything out. */
export function emit(req: Req, user: User, event: string, data: Record<string, unknown>): void {
  if (user.is_demo) return;
  try {
    dispatcher(req.ctx).publish(user.id, user.username, event, data);
  } catch (e) {
    console.error('webhook emit failed', e);
  }
}
