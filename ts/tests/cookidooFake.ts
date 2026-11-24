// A local stand-in for Cookidoo and its identity provider, shaped after the answers cookidoo-api 0.19.0 reads (raw_types.py, its tests).
// The real client talks to constant https hosts; the tests give it an `Outgoing` that sends everything to this server and refuses any
// other host. Nothing leaves the machine.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { OutError, type Outgoing, type OutRequest, type OutResponse } from '../core/outgoing.ts';

export const CIAM = 'ciam.prod.cookidoo.vorwerk-digital.com';
export const SITE = 'cookidoo.de';
export const GOOD_MAIL = 'good@example.invalid';
export const GOOD_PW = 'good-password-not-real';
export const REDIRECT = 'com.vorwerk.cookidoo://code-grant';

export interface Seen { host: string; method: string; path: string; headers: Record<string, string>; body: string }

export class FakeCookidoo {
  server!: Server;
  port = 0;
  seen: Seen[] = [];
  // behaviour switches
  expiresIn = 43200;
  rejectApi = 0; // answer the next n API calls with 401
  wellKnownFail = 0; // answer the next n well-known requests with 500
  badState = false;
  evilRedirect = false;
  wellKnownHref: Record<string, string> = {};
  apiStatus = 200;
  apiContentType = 'application/json';
  recipe: any = null;
  // state of the provider
  private sessions = new Map<string, { state: string; challenge: string }>();
  private codes = new Map<string, { challenge: string }>();
  token = 'access-1';
  refresh = 'refresh-1';
  n = 0;
  refreshed = 0;

  async start(): Promise<this> {
    this.server = createServer((q, r) => void this.handle(q, r));
    await new Promise<void>((res) => this.server.listen(0, '127.0.0.1', res));
    this.port = (this.server.address() as { port: number }).port;
    this.recipe = defaultRecipe();
    return this;
  }
  stop(): void { this.server.close(); }
  calls(host?: string): Seen[] { return this.seen.filter((s) => !host || s.host === host); }

  private async handle(q: IncomingMessage, r: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of q) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const host = String(q.headers['x-orig-host']);
    const url = new URL(q.url!, 'http://x');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(q.headers)) if (typeof v === 'string') headers[k] = v;
    this.seen.push({ host, method: q.method!, path: url.pathname + url.search, headers, body });
    const send = (status: number, payload: unknown = '', extra: Record<string, string | string[]> = {}) => {
      const json = typeof payload === 'object';
      r.writeHead(status, { 'content-type': json ? 'application/json' : 'text/html', ...extra });
      r.end(json ? JSON.stringify(payload) : String(payload));
    };
    if (host === CIAM) return this.ciam(q, url, body, headers, send);
    if (host === SITE) return this.site(q, url, headers, send);
    send(404);
  }

  private ciam(q: IncomingMessage, url: URL, body: string, headers: Record<string, string>, send: (s: number, p?: unknown, h?: Record<string, string | string[]>) => void): void {
    const cookie = headers.cookie ?? '';
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, { authorization_endpoint: `https://${CIAM}/authorize`, token_endpoint: `https://${CIAM}/token` });
    }
    if (url.pathname === '/authorize') {
      const id = `sess-${++this.n}`;
      this.sessions.set(id, { state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')! });
      return send(302, '', { location: `/login-page`, 'set-cookie': [`sid=${id}; Path=/; HttpOnly`, `other=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/`] });
    }
    if (url.pathname === '/login-page') {
      if (!/sid=sess-/.test(cookie)) return send(403, 'no cookie');
      return send(200, `<html><form><input type="hidden" name="requestId" value="req-${cookie.match(/sid=(sess-\d+)/)![1]}"/></form></html>`);
    }
    if (url.pathname === '/login-srv/login' && q.method === 'POST') {
      const form = new URLSearchParams(body);
      const sid = cookie.match(/sid=(sess-\d+)/)?.[1];
      if (!sid || form.get('requestId') !== `req-${sid}`) return send(400, 'bad request id');
      if (form.get('username') !== GOOD_MAIL || form.get('password') !== GOOD_PW) return send(200, '<html>wrong</html>'); // no redirect: refused
      if (this.evilRedirect) return send(302, '', { location: 'https://evil.example/steal' });
      return send(302, '', { location: `/after-login?sid=${sid}` });
    }
    if (url.pathname === '/after-login') {
      const sid = url.searchParams.get('sid')!;
      if (!cookie.includes(`sid=${sid}`)) return send(403, 'no cookie');
      const s = this.sessions.get(sid)!;
      const code = `code-${++this.n}`;
      this.codes.set(code, { challenge: s.challenge });
      const state = this.badState ? 'wrong' : s.state;
      return send(302, '', { location: `${REDIRECT}?code=${code}&state=${state}` });
    }
    if (url.pathname === '/token' && q.method === 'POST') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        const c = this.codes.get(form.get('code') ?? '');
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!c || c.challenge !== challenge || form.get('client_id') !== 'mobile-android' || form.get('redirect_uri') !== REDIRECT) return send(400, { error: 'invalid_grant' });
        this.codes.delete(form.get('code')!);
        this.token = `access-${++this.n}`;
        return send(200, { access_token: this.token, refresh_token: this.refresh, expires_in: this.expiresIn });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== this.refresh) return send(400, { error: 'invalid_grant' });
        this.refreshed++;
        this.token = `access-${++this.n}`;
        return send(200, { access_token: this.token, expires_in: this.expiresIn }); // no new refresh token: the old one stays
      }
    }
    send(404);
  }

  private site(q: IncomingMessage, url: URL, headers: Record<string, string>, send: (s: number, p?: unknown, h?: Record<string, string | string[]>) => void): void {
    const wk = /^\/([\w/]+)\/\.well-known\/home$/.exec(url.pathname);
    if (wk) {
      if (this.wellKnownFail > 0) { this.wellKnownFail--; return send(500); }
      const links: Record<string, { href: string }> = {
        'recipe:details': { href: `https://${SITE}/recipes/recipe/{lang}/{id}` },
        'organize:api-custom-list': { href: `https://${SITE}/organize/{lang}/api/custom-list{?page}` },
        'organize:api-managed-list': { href: `https://${SITE}/organize/{lang}/api/managed-list{?page}` },
        'planning:api-my-week-from-date': { href: `/planning/{lang}/api/my-week/{dayKey}` },
      };
      for (const [k, v] of Object.entries(this.wellKnownHref)) links[k] = { href: v };
      const mine = Object.fromEntries(Object.entries(links).filter(([k]) => k.startsWith(wk[1] === 'recipes/recipe' ? 'recipe:' : wk[1] + ':')));
      return send(200, { _links: mine });
    }
    if (this.rejectApi > 0) { this.rejectApi--; return send(401, { error_description: 'expired' }); }
    if (headers.authorization !== `Bearer ${this.token}`) return send(401, { error_description: 'bad token' });
    if (this.apiStatus !== 200) return send(this.apiStatus);
    const ct = { 'content-type': this.apiContentType };
    const j = (payload: unknown) => { const body = JSON.stringify(payload); return send(200, body, ct); };
    if (url.pathname === '/recipes/recipe/de-DE/r100001') return j(this.recipe);
    if (url.pathname.startsWith('/planning/de-DE/api/my-week/')) {
      return j({ myDays: [{ id: url.pathname.split('/').pop(), title: 'Monday', recipes: [{ id: 'r100001', title: 'Red lentil salad', totalTime: 3600, assets: null }], customerRecipes: [{ id: 'cu1', title: 'Mine', totalTime: 60, assets: null }], customerRecipeIds: ['cu1'] }, { id: '2026-01-13', title: 'Tuesday', recipes: [] }] });
    }
    if (url.pathname === '/organize/de-DE/api/custom-list') {
      return j({ customlists: [{ id: 'c1', title: 'Favourites', chapters: [{ title: 'ch', recipes: [{ id: 'r100001', title: 'Red lentil salad', totalTime: 3600.0 }, { id: 'r100002', title: 'Soup', totalTime: 60 }] }] }] });
    }
    if (url.pathname === '/organize/de-DE/api/managed-list') {
      return j({ managedlists: [{ id: 'm1', title: 'Quick dinners', description: 'x', chapters: [] }] });
    }
    send(404);
  }

  /** The `Outgoing` that sends everything for the two known hosts to this server and refuses anything else. Redirects are never followed. */
  outgoing(): Outgoing {
    const refused: string[] = [];
    const out: Outgoing & { refused: string[] } = {
      refused,
      resolve: async () => { throw new OutError('connect'); },
      fetch: async (purpose: string, req: OutRequest): Promise<OutResponse> => {
        if (purpose !== 'cookidoo') throw new Error(`unexpected purpose ${purpose}`);
        const u = new URL(req.url);
        if (u.hostname !== CIAM && u.hostname !== SITE) { refused.push(u.hostname); throw new OutError('connect', 'unknown host'); }
        if (u.protocol !== 'https:') throw new Error('the real hosts are https only');
        const res = await fetch(`http://127.0.0.1:${this.port}${u.pathname}${u.search}`, {
          method: req.method ?? 'GET', redirect: 'manual', body: req.body as string | undefined, headers: { ...(req.headers ?? {}), 'x-orig-host': u.hostname },
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        return { status: res.status, headers, setCookies: res.headers.getSetCookie(), body: new Uint8Array(await res.arrayBuffer()) };
      },
    };
    return out;
  }
}

export function defaultRecipe(): any {
  return {
    id: 'r100001', title: 'Red lentil salad', servingSize: { quantity: { value: 4 }, unitNotation: 'Portionen' },
    times: [{ type: 'activeTime', quantity: { value: 600 } }, { type: 'totalTime', quantity: { value: 3600 } }],
    descriptiveAssets: [{ landscape: null, portrait: 'https://img.example/p/{transformation}/x.jpg' }],
    nutritionGroups: [{ name: 'Per portion', recipeNutritions: [
      { quantity: 1, unitNotation: 'Portion', nutritions: [{ number: 497, type: 'kcal', unittype: 'kcal' }, { number: 8, type: 'fat', unittype: 'g' }, { number: 1168, type: 'sodium', unittype: 'mg' }] },
      { quantity: 100, unitNotation: 'g', nutritions: [{ number: 150, type: 'kcal', unittype: 'kcal' }] },
    ] }],
  };
}
