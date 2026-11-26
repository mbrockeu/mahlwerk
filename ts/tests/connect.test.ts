// "Sign in with the browser" for the iPhone app (core/routes/connect.ts): confirm with the normal sign-in, trade the one-time code
// with the PKCE verifier for a key, and everything that must fail.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { CODE_SECONDS } from '../core/routes/connect.ts';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) await w.close(); });
async function world(env?: Record<string, string>) { const w = await makeWorld({ on: false, env }); worlds.push(w); return w; }

const VERIFIER = 'v'.repeat(20) + '-._~' + 'A1b2C3d4E5f6G7h8I9j0K'; // 45 characters of the allowed set
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');
const confirm = (w: World, who = w.ann, extra: Record<string, unknown> = {}) =>
  who.post('/api/v1/connect/app', { challenge: challengeOf(VERIFIER), challenge_method: 'S256', device: 'iPhone von Ann', ...extra });
const codeOf = (redirect: string) => new URL(redirect).searchParams.get('code')!;
async function exchange(w: World, code: string | null, verifier: string = VERIFIER, extra: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${w.port}/api/v1/connect/exchange`, { method: 'POST', body: JSON.stringify({ verifier }),
    headers: { 'content-type': 'application/json', ...(code === null ? {} : { authorization: `Bearer ${code}` }), ...extra } });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}
const bearer = (w: World, token: string, path: string) =>
  fetch(`http://127.0.0.1:${w.port}${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);

test('confirm, then trade the code: a write key named after the device, usable at once, listed and revocable', async () => {
  const w = await world();
  const before = (await w.ann.get('/api/v1/me/tokens')).json.length;
  const c = await confirm(w);
  assert.equal(c.status, 200);
  assert.match(c.json.redirect, /^mahlwerk:\/\/connected\?code=mw_c[A-Za-z0-9_-]+$/);
  assert.equal(c.json.expires_in, CODE_SECONDS);
  // confirming alone makes no key
  assert.equal((await w.ann.get('/api/v1/me/tokens')).json.length, before);
  const x = await exchange(w, codeOf(c.json.redirect));
  assert.equal(x.status, 200);
  assert.match(x.json.token, /^mw_/);
  assert.deepEqual([x.json.name, x.json.scope, x.json.username], ['iPhone-App: iPhone von Ann', 'write', 'ann']);
  const list = (await w.ann.get('/api/v1/me/tokens')).json;
  assert.equal(list.length, before + 1);
  assert.deepEqual([list[0].name, list[0].scope, list[0].expires_at], ['iPhone-App: iPhone von Ann', 'write', null]);
  assert.equal(await bearer(w, x.json.token, '/api/v1/me'), 200);
  assert.equal((await w.ann.delete(`/api/v1/me/tokens/${list[0].id}`)).status, 204);
  assert.equal(await bearer(w, x.json.token, '/api/v1/me'), 401);
});

test('the code works once, only with the right verifier, only within its time, and not as a key', async () => {
  const w = await world();
  // a wrong verifier uses the code up
  let code = codeOf((await confirm(w)).json.redirect);
  assert.equal((await exchange(w, code, 'w'.repeat(43))).status, 400);
  assert.equal((await exchange(w, code)).status, 400);
  // used once
  code = codeOf((await confirm(w)).json.redirect);
  assert.equal((await exchange(w, code)).status, 200);
  assert.equal((await exchange(w, code)).status, 400);
  // expired
  code = codeOf((await confirm(w)).json.redirect);
  w.clock.now += CODE_SECONDS;
  assert.equal((await exchange(w, code)).status, 400);
  // a pending code is no key anywhere else, and it is not used up by trying
  code = codeOf((await confirm(w)).json.redirect);
  assert.equal(await bearer(w, code, '/api/v1/me'), 401);
  // no code, a made-up code, a real key instead of a code, a verifier of the wrong form
  assert.equal((await exchange(w, null)).status, 403); // without a bearer the CSRF check refuses it first
  assert.equal((await exchange(w, 'mw_cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 400);
  const key = (await w.ann.post('/api/v1/me/tokens', { name: 'k', scope: 'write' })).json.token;
  assert.equal((await exchange(w, key)).status, 400);
  assert.equal((await exchange(w, code, 'short')).status, 400);
  assert.equal((await exchange(w, code)).status, 400); // the malformed attempt used it up
});

test('confirming needs the normal sign-in, a valid challenge and the switch; the exchange checks the account again', async () => {
  const w = await world();
  const key = (await w.ann.post('/api/v1/me/tokens', { name: 'k', scope: 'write' })).json.token;
  // with a key instead of the sign-in
  const viaKey = await fetch(`http://127.0.0.1:${w.port}/api/v1/connect/app`, { method: 'POST',
    body: JSON.stringify({ challenge: challengeOf(VERIFIER), challenge_method: 'S256', device: 'x' }),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } });
  assert.equal(viaKey.status, 403);
  // without the CSRF header (a foreign page cannot add it)
  const forged = await fetch(`http://127.0.0.1:${w.port}/api/v1/connect/app`, { method: 'POST',
    body: JSON.stringify({ challenge: challengeOf(VERIFIER), challenge_method: 'S256', device: 'x' }),
    headers: { 'content-type': 'application/json', 'remote-user': 'ann' } });
  assert.equal(forged.status, 403);
  assert.equal((await confirm(w, w.ann, { challenge_method: 'plain' })).status, 422);
  assert.equal((await confirm(w, w.ann, { challenge: 'short' })).status, 422);
  assert.equal((await confirm(w, w.ann, { device: '' })).status, 422);
  // the device name is cleaned and capped
  const c = await confirm(w, w.ann, { device: 'Ann\u0000s‮ iPhone' });
  assert.equal((await exchange(w, codeOf(c.json.redirect))).json.name, 'iPhone-App: Anns iPhone');
  // blocked between confirming and the exchange
  const code = codeOf((await confirm(w)).json.redirect);
  await w.ctx.db.run("UPDATE user SET disabled = 1 WHERE username = 'ann'");
  assert.equal((await exchange(w, code)).status, 400);
  // keys switched off
  const v = await world({ MAHLWERK_TOKENS: 'false' });
  assert.equal((await confirm(v)).status, 404);
});

test('a person keeps at most three waiting codes, and revoking their access drops them', async () => {
  const w = await world();
  const codes: string[] = [];
  for (let i = 0; i < 4; i++) codes.push(codeOf((await confirm(w)).json.redirect));
  assert.equal((await exchange(w, codes[0]!)).status, 400); // the oldest made room
  const ben = codeOf((await confirm(w, w.ben)).json.redirect);
  await w.admin.get('/api/v1/me');
  assert.equal((await w.admin.post('/api/v1/admin/users/ann/revoke-access')).status, 200);
  for (const c of codes.slice(1)) assert.equal((await exchange(w, c)).status, 400);
  assert.equal((await exchange(w, ben)).status, 200); // somebody else's stays
});
