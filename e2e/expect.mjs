// Minimal polling assertions on locators (playwright-core has no expect): expect(loc).toBeVisible() / .toHaveCount(n) / .toContainText(s) / .not.<same>.
const poll = async (check, describe, timeout = 8000) => {
  const end = Date.now() + timeout; let last;
  for (;;) {
    try { const r = await check(); if (r.ok) return; last = r.got; } catch (e) { last = `error: ${e.message.split('\n')[0]}`; }
    if (Date.now() > end) throw new Error(`expected ${describe}; last seen: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const make = (loc, neg) => {
  const want = (ok) => (neg ? !ok : ok);
  const n = neg ? 'not ' : '';
  return {
    toBeVisible: () => poll(async () => { const v = await loc.first().isVisible(); return { ok: want(v), got: v }; }, `${n}visible: ${loc}`),
    toHaveCount: (c) => poll(async () => { const k = await loc.count(); return { ok: want(k === c), got: k }; }, `${n}count ${c}: ${loc}`),
    toHaveAttr: (a, v) => poll(async () => { const x = await loc.first().getAttribute(a); return { ok: want(x === v), got: x }; }, `${n}attribute ${a}=${v}: ${loc}`),
    toContainText: (s) => poll(async () => { const t = (await loc.first().innerText().catch(() => '')) ?? ''; return { ok: want(t.includes(s)), got: t }; }, `${n}text "${s}": ${loc}`),
  };
};
export const expect = (loc) => ({ ...make(loc, false), not: make(loc, true) });
