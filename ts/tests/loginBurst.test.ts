// A burst of concurrent wrong guesses is held back like the same guesses one after the other (finding of the security audit of
// 28.11.): attempts that are still being checked count as failures that are not recorded yet.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { LoginThrottle } from '../core/throttle.ts';
import { dispatcher } from '../core/webhooks.ts';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) { dispatcher(w.ctx).stop(); await w.close(); } });
const PW = 'the-right-password-1';

async function world() {
  const w = await makeWorld({ on: false, env: { MAHLWERK_AUTH: 'local' } });
  worlds.push(w);
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${w.port}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-mahlwerk-request': '1' } });
    await res.text();
    return res.status;
  };
  assert.equal(await call('/api/v1/auth/setup', { username: 'owner', password: PW }), 201);
  const login = (password: string, username = 'owner') => call('/api/v1/auth/login', { username, password });
  return { w, login };
}

test('a burst of concurrent wrong guesses is throttled like sequential ones', async () => {
  const { w, login } = await world();
  const codes = await Promise.all(Array.from({ length: 40 }, (_, i) => login(`wrong-guess-${i}-xxxxx`)));
  const verified = codes.filter((c) => c === 401).length;
  assert.ok(verified <= 5, `${verified} guesses were checked`); // the 5th failure blocks, exactly as one after the other
  assert.ok(codes.filter((c) => c === 429).length >= 35);
  assert.equal(await login(PW), 429); // the address is held back for now ...
  w.clock.now += 1000;
  assert.equal(await login(PW), 200); // ... and the right password gets in afterwards
});

test('a burst for one name from many addresses is serialised once enough attempts are in flight', () => {
  const t = new LoginThrottle(() => 1000);
  const ends = [1, 2, 3, 4, 5].map((n) => t.begin([`ip:${n}`, `p:x|ip:${n}`], 'x'));
  assert.equal(t.underPressure('x'), true);
  ends.forEach((e) => e());
  assert.equal(t.underPressure('x'), false);
});

test('attempts in flight block an address from the 6th on, and ending them frees it; a success still clears the pair', () => {
  const t = new LoginThrottle(() => 1000);
  const ends = [1, 2, 3, 4].map(() => t.begin(['ip:a', 'p:x|ip:a'], 'x'));
  assert.equal(t.wait('ip:a', 'p:x|ip:a'), 0); // 4 in flight: a 5th may start, as the 5th sequential attempt may
  const fifth = t.begin(['ip:a', 'p:x|ip:a'], 'x');
  assert.ok(t.wait('ip:a', 'p:x|ip:a') > 0); // a 6th may not
  ends.forEach((e) => e()); fifth(); fifth(); // ending twice does no harm
  assert.equal(t.wait('ip:a', 'p:x|ip:a'), 0);
  for (let i = 0; i < 6; i++) t.fail(['p:x|ip:a']);
  assert.ok(t.wait('p:x|ip:a') > 0);
  t.success('p:x|ip:a');
  assert.equal(t.wait('p:x|ip:a'), 0);
});
