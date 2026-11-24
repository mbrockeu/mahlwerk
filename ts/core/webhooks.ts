// Outgoing webhooks (webhooks.py): events of a user are POSTed to the URLs the user registered.
//
// Delivery never happens in the request path. A request only puts a small job on a queue (`Dispatcher.publish`); the dispatcher
// looks up the user's hooks and delivers to each, at most POOL at a time. A delivery tries up to three times (with a wait in
// between), never follows redirects and gives up after a timeout of five seconds per try. A broken or slow hook therefore can
// neither slow down nor fail a request. Each delivery is logged (`webhook_delivery`, the last 20 per hook are kept). The body is
// signed with the hook's secret: header `X-Mahlwerk-Signature: sha256=<hex HMAC-SHA256 of the raw body>`.
import { featureOn, hostAllowed, hostListed } from './features.ts';
import type { Ctx, Req, User } from './http.ts';
import { pickAddress, sameHostEverywhere } from './netguard.ts';
import { outgoing } from './outgoing.ts';
import {
  getWebhook, hooksForEvent, pruneDeliveries, startDelivery, updateDelivery, webhookById, type Hook,
} from './store/webhooks.ts';
import { urlsplit } from './urlsplit.ts';

export const PING = 'ping';
const TIMEOUT = 5.0;
const MAX_ATTEMPTS = 3;
const BACKOFF = [2.0, 10.0]; // seconds to wait before the second and the third try
const POOL = 4;
const MAX_URL = 500;

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
 * check existed, or whose DNS name now points inside, is refused too. */
export async function target(ctx: Ctx, url: string, host: string | null): Promise<string | false> {
  if (checkUrl(url) || !(await hostAllowed(ctx, host)) || !sameHostEverywhere(url)) return false;
  try {
    const parts = urlsplit(url);
    const port = parts.port || (url.toLowerCase().startsWith('https') ? 443 : 80);
    return await pickAddress(ctx, host!, port, await hostListed(ctx, host));
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
  private waiting: (() => void)[] = [];
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
    let hooks: Hook[];
    if (job.hook_id !== null) {
      const hook = await webhookById(db, job.hook_id);
      hooks = hook && (await getWebhook(db, job.user_id, hook.id)) ? [hook] : [];
    } else hooks = await hooksForEvent(db, job.user_id, job.event);
    for (const hook of hooks) {
      const deliveryId = await startDelivery(db, hook.id, job.event);
      this.begin();
      void this.slot().then(() => this.deliver(hook, deliveryId, job)).finally(() => { this.release(); this.done(); });
    }
  }

  private async slot(): Promise<void> {
    if (this.running < POOL) { this.running++; return; }
    await new Promise<void>((r) => this.waiting.push(r)); // the releasing delivery hands its place over
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); else this.running--;
  }

  private sleep(seconds: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve(true);
      const t = setTimeout(() => resolve(false), seconds * 1000);
      this.wake.push(() => { clearTimeout(t); resolve(true); });
    });
  }

  private async deliver(hook: Hook, deliveryId: number, job: Job): Promise<void> {
    const { db } = this.ctx;
    let status: number | null = null;
    let error: string | null = null;
    let attempts = 0;
    try {
      const host = hostOf(hook.url);
      // json.dumps(separators=(",", ":"), ensure_ascii=False, allow_nan=False)
      const body = new TextEncoder().encode(JSON.stringify({
        event: job.event, occurred_at: new Date(job.at * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        user: { username: job.username }, data: job.data,
      }, (_k, v) => { if (typeof v === 'number' && !Number.isFinite(v)) throw new RangeError('NaN'); return v; }));
      const headers = {
        'Content-Type': 'application/json', 'User-Agent': 'Mahlwerk-Webhook', 'X-Mahlwerk-Event': job.event,
        'X-Mahlwerk-Delivery': String(deliveryId), 'X-Mahlwerk-Signature': await sign(hook.secret!, body),
      };
      const address = await target(this.ctx, hook.url, host);
      if (address === false) error = 'target not allowed';
      else {
        while (attempts < MAX_ATTEMPTS && !this.stopped) {
          attempts++;
          status = null;
          error = null;
          try {
            // one POST; redirects are not followed, environment proxies are not used; the connection goes to the address that was
            // checked, Host and TLS keep the name of the URL
            status = (await outgoing(this.ctx).fetch('webhook', { method: 'POST', url: hook.url, headers, body, timeout: this.timeout, address })).status;
          } catch {
            error = 'delivery failed'; // one text for every network problem: it must not tell a closed port from a filtered one or a timeout
          }
          if (status !== null) {
            if (status >= 200 && status < 300) break;
            error = `HTTP ${status}`;
            if (status < 500 && status !== 429) break; // the receiver said no; asking again will not help
          }
          await updateDelivery(db, deliveryId, attempts, status, error, false);
          if (attempts < MAX_ATTEMPTS && (await this.sleep(this.backoff[Math.min(attempts - 1, this.backoff.length - 1)]!))) break;
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

/** Called by the routes after a change. Never throws. The demo account never sends anything out. */
export function emit(req: Req, user: User, event: string, data: Record<string, unknown>): void {
  if (user.is_demo) return;
  try {
    dispatcher(req.ctx).publish(user.id, user.username, event, data);
  } catch (e) {
    console.error('webhook emit failed', e);
  }
}
