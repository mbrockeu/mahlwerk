// Small shared helpers for the UI smoke tests: one browser per test file, a page that fails the test on page errors / 5xx, API setup via HTTP.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

export const BASE = process.env.MW_BASE;
export const AUTH = process.env.MW_AUTH;
/** `app`: the app build with the fake native side (app/), the API answered in the page; else a server. */
export const APP = process.env.MW_TARGET === 'app';
const CONTEXT = { baseURL: BASE, locale: 'en-US', viewport: { width: 1280, height: 900 }, acceptDownloads: true };

// app mode: ONE context per test file (its SharedWorker holds the data, like the phone), a helper page that keeps the worker alive
// and answers the API calls of the tests; every test gets a new page in that context instead of a new context
let shared = null;

export async function launch() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--disable-gpu', '--no-sandbox'], headless: true });
  if (APP) {
    const context = await browser.newContext(CONTEXT);
    await context.addInitScript({ content: readFileSync(new URL('./app/init.js', import.meta.url), 'utf8') });
    const helper = await context.newPage();
    await helper.goto('/');
    await helper.waitForFunction(() => typeof window.mahlwerkLocal === 'function', null, { timeout: 15000 });
    shared = { context, helper };
  }
  return browser;
}

/** HTTP API of the server under test (single mode: no login; local mode: pass the cookie). In app mode: the app host of the helper page. */
export function apiClient(cookie) {
  if (APP) return async (method, path, body) => {
    if (!shared) throw new Error('launch() first');
    const r = await shared.helper.evaluate(async ([m, p, b]) => {
      const headers = { 'X-Mahlwerk-Request': '1' };
      if (b !== undefined) headers['content-type'] = 'application/json';
      const res = await window.mahlwerkLocal(`api/v1/${p}`, { method: m, headers, body: b === undefined ? undefined : JSON.stringify(b) });
      return { ok: res.ok, status: res.status, text: await res.text() };
    }, [method, path, body]);
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 200)}`);
    return r.text ? JSON.parse(r.text) : null;
  };
  return async (method, path, body) => {
    const headers = { 'X-Mahlwerk-Request': '1', ...(cookie ? { cookie } : {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${BASE}/api/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
}

/** A fresh browser context (English, wide screen) and page; problems seen during the test are collected in `problems`. */
export async function newPage(browser, { cookies, moments = true } = {}) {
  let context, page;
  if (APP) {
    page = await shared.context.newPage();
    context = { close: () => page.close() }; // the context (and its data) stays for the next test
  } else {
    context = await browser.newContext(CONTEXT);
    if (cookies) await context.addCookies(cookies);
    page = await context.newPage();
  }
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on('console', (m) => { if (m.text().startsWith('MW-5XX ')) problems.push(m.text().slice(7)); }); // app mode (app/init.js)
  page.setDefaultTimeout(8000);
  // a new badge covers the screen with a dialog: click it away wherever it turns up (the badge test turns this off)
  if (moments) await page.addLocatorHandler(page.getByRole('button', { name: 'Continue', exact: true }), (b) => b.click());
  return { page, context, problems };
}

/** Run one test body with a fresh page; on failure save a screenshot to MW_SHOTS; always fail on collected problems. */
export async function withPage(browser, name, body, opts) {
  const { page, context, problems } = await newPage(browser, opts);
  try {
    await body(page, context);
  } catch (err) {
    await page.screenshot({ path: `${process.env.MW_SHOTS ?? '/tmp'}/${name.replace(/\W+/g, '_')}.png` }).catch(() => {});
    throw err;
  } finally {
    await context.close();
  }
  if (problems.length) throw new Error(`problems during the flow:\n${problems.join('\n')}`);
}

export const today = () => new Date().toLocaleDateString('sv');
export const shift = (iso, days) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export const food = (name, kcal, protein = 10, carbs = 10, fat = 5) => ({ name, unit: 'g', per_100: { kcal, protein, carbs, fat } });
