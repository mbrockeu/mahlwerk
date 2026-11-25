// Cross-read check, TS half (see python_side.py): `write <dir>` stores what the TS server writes, `read <dir>` verifies what the
// Python half stored. Temp files only. Run through run.sh.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { hashToken } from '../core/auth.ts';
import { tokenUrlsafe } from '../core/crypto.ts';
import { openSchema } from '../core/db.ts';
import * as demoAccount from '../core/demoAccount.ts';
import { openLogin, sealLogin } from '../core/oidc.ts';
import { PasswordHasher } from '../core/passwords.ts';
import { getSettings, setSetting } from '../core/store/settings.ts';
import { secretKey } from '../core/store/globals.ts';
import { createToken, findToken } from '../core/store/tokens.ts';
import { createLocalUser, createSession, findSession, localUser } from '../core/store/users.ts';
import { Vault } from '../core/vault.ts';
import type { Ctx } from '../core/http.ts';
import { authServices } from '../server/authServices.ts';
import { openSqlite } from '../server/sqlite.ts';

const T = 1_800_000_000;
const PASS = 'correct horse battery ünï ✓';
const PASS_LOW = 'another long passphrase';
const LOW: [number, number, number] = [16, 8, 1];
const PASSPHRASE = 'a passphrase of at least thirty-two characters!!';
const SETTINGS = { display_name: 'Jürgen ✓ 日本', fasting: { enabled: true, target_hours: 16.5 }, water_glasses: [250, 500], tiny: 0.1 + 0.2, big: 2 ** 53,
  home: [{ id: 'ring', hidden: false, wide: true }], nothing: null };
const SECRET = { email: 'ünï@example.org', password: 'p"w\'\\ ✓', n: 1.5 };
const schema = readFileSync(new URL('../core/schema.sql', import.meta.url), 'utf8');

function check(cond: boolean, what: string): void {
  if (!cond) { console.log('FAIL (ts side):', what); process.exit(1); }
  console.log('ok   (ts side):', what);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortKeys = (v: any): any => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

async function open(path: string, env: Record<string, string>, cost?: [number, number, number]): Promise<Ctx> {
  const db = openSqlite(path);
  await openSchema(db, schema);
  return { db, env, now: () => T, services: { ...authServices(path), ...(cost ? { passwordCost: cost } : {}) } };
}

async function write(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const facts: Record<string, unknown> = { t: T, settings: SETTINGS, secret: SECRET, writer: 'ts' };
  for (const variant of ['env', 'file']) {
    const ctx = await open(`${dir}/${variant}.db`, variant === 'env' ? { MAHLWERK_SECRET_KEY: PASSPHRASE } : {});
    const low = new PasswordHasher(ctx, LOW);
    const alice = await createLocalUser(ctx.db, 'alice', 'Alice', await new PasswordHasher(ctx).hash(PASS), true, true);
    const bob = await createLocalUser(ctx.db, 'bob', 'Bob', await low.hash(PASS_LOW), false, false);
    const session = tokenUrlsafe(32);
    await createSession(ctx.db, alice.id, await hashToken(session), T, 30 * 86400);
    const token = 'mw_' + tokenUrlsafe(32);
    await createToken(ctx.db, alice.id, 'key', token.slice(0, 8), await hashToken(token), 'read', null);
    for (const [k, v] of Object.entries(SETTINGS)) await setSetting(ctx.db, alice.id, k, v);
    const vault = new Vault(ctx);
    await vault.put(alice.id, 'cookidoo', SECRET);
    await vault.put(0, 'household', { x: 1 });
    const dkey = await secretKey(ctx.db, demoAccount.KEY_NAME), okey = await secretKey(ctx.db, 'oidc_cookie');
    facts[variant] = { alice: alice.id, bob: bob.id, session, token,
      demo_cookie: await demoAccount.seal(dkey, alice.id, await hashToken(session), T),
      login_cookie: await sealLogin(okey, { state: 'st', nonce: 'no', verifier: 've', next: '/x' }, T) };
    ctx.db.close?.();
  }
  writeFileSync(`${dir}/facts.json`, JSON.stringify(facts));
}

async function read(dir: string): Promise<void> {
  const facts = JSON.parse(readFileSync(`${dir}/facts.json`, 'utf8'));
  for (const variant of ['env', 'file']) {
    const f = facts[variant];
    const path = `${dir}/${variant}.db`;
    const env = variant === 'env' ? { MAHLWERK_SECRET_KEY: PASSPHRASE } : {};
    const ctx = await open(path, env);
    const hasher = new PasswordHasher(ctx), low = new PasswordHasher(ctx, LOW);
    const alice = (await localUser(ctx.db, 'alice'))!, bob = (await localUser(ctx.db, 'bob'))!;
    check((await hasher.verify(PASS, alice.password_hash)) && !(await hasher.verify('wrong', alice.password_hash)), `${variant}: default-cost hash of alice`);
    check((await low.verify(PASS_LOW, bob.password_hash)) && !(await low.verify(PASS, bob.password_hash)), `${variant}: low-cost hash of bob`);
    check(!hasher.needsRehash(alice.password_hash) && hasher.needsRehash(bob.password_hash), `${variant}: needs_rehash follows the cost`);
    const row = await findSession(ctx.db, await hashToken(f.session), facts.t + 10, 30 * 86400, 180 * 86400);
    check(row !== null && row.id === f.alice && row.local_admin, `${variant}: session is found`);
    check((await findSession(ctx.db, (await hashToken(f.session)) + '0', facts.t, 86400, 86400)) === null, `${variant}: unknown session is not found`);
    const tok = await findToken(ctx.db, await hashToken(f.token));
    check(tok !== undefined && tok.scope === 'read' && tok.id === f.alice, `${variant}: access token is found`);
    check((await findToken(ctx.db, await hashToken(f.token + 'x'))) === undefined, `${variant}: wrong token is not found`);
    check(same(sortKeys(await getSettings(ctx.db, f.alice)), sortKeys(facts.settings)), `${variant}: settings (non-ASCII, floats, null, nested)`);
    const vault = new Vault(ctx);
    check(same(sortKeys(await vault.get(f.alice, 'cookidoo')), sortKeys(facts.secret)), `${variant}: vault secret`);
    check(same(await vault.get(0, 'household'), { x: 1 }), `${variant}: household secret`);
    check((await vault.get(f.bob, 'cookidoo')) === null && (await vault.state(f.bob, 'cookidoo')) === 'none', `${variant}: no secret for bob`);
    const dkey = await secretKey(ctx.db, demoAccount.KEY_NAME), okey = await secretKey(ctx.db, 'oidc_cookie');
    const sh = await hashToken(f.session);
    check(await demoAccount.openCookie(dkey, f.demo_cookie, f.alice, sh, facts.t + 10), `${variant}: demo cookie opens`);
    check(!(await demoAccount.openCookie(dkey, f.demo_cookie, f.bob, sh, facts.t + 10)), `${variant}: demo cookie of another user is refused`);
    check(!(await demoAccount.openCookie(dkey, f.demo_cookie, f.alice, sh, facts.t + 1e6)), `${variant}: demo cookie expires`);
    const pending = await openLogin(okey, f.login_cookie, facts.t + 10);
    check(pending !== null && same([pending.state, pending.nonce, pending.verifier, pending.next], ['st', 'no', 've', '/x']), `${variant}: login cookie opens`);
    check((await openLogin(okey, f.login_cookie, facts.t + 700)) === null, `${variant}: login cookie expires`);
    check((await openLogin(okey, f.login_cookie.slice(0, -2) + 'AA', facts.t)) === null, `${variant}: damaged login cookie is refused`);
    // negatives on a copy: a damaged blob and a blob moved to another owner do not decrypt
    const copy = `${dir}/${variant}-copy.db`;
    copyFileSync(path, copy);
    if (existsSync(`${path}.key`)) copyFileSync(`${path}.key`, `${copy}.key`);
    const con = new DatabaseSync(copy);
    const blob = new Uint8Array((con.prepare("SELECT blob FROM secret WHERE user_id = ? AND name = 'cookidoo'").get(f.alice) as any).blob);
    con.prepare("INSERT INTO secret (user_id, name, blob, updated_at) VALUES (?, 'cookidoo', ?, 1)").run(f.bob, blob);
    const broken = blob.slice();
    broken[20]! ^= 1;
    con.prepare("INSERT INTO secret (user_id, name, blob, updated_at) VALUES (?, 'broken', ?, 1)").run(f.alice, broken);
    con.close();
    const cctx = await open(copy, env);
    const cv = new Vault(cctx);
    check((await cv.get(f.bob, 'cookidoo')) === null, `${variant}: a blob copied to another owner does not decrypt`);
    check((await cv.get(f.alice, 'broken')) === null, `${variant}: a damaged blob does not decrypt`);
    ctx.db.close?.();
    cctx.db.close?.();
  }
}

const [mode, dir] = process.argv.slice(2) as ['read' | 'write', string];
await (mode === 'write' ? write(dir) : read(dir));
