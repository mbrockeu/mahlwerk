// When the server reads a request body (server/app.ts): only for a caller who may call the route, right before the handler, and at
// most two large uploads at the same time. Raw sockets, so the test sees what happens while the client is still sending.
import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { after, test } from 'node:test';
import { makeWorld, type World } from './cookidooHarness.ts';

const worlds: World[] = [];
after(async () => { for (const w of worlds) await w.close(); });

const PREVIEW = '/api/v1/me/import/preview';

/** Opens a connection and sends the head of a POST with `length` as Content-Length and the first `sent` bytes of the body. */
function start(w: World, length: number, sent: number, user: string | null): { socket: Socket; answer: Promise<string> } {
  const socket = connect(w.port, '127.0.0.1');
  let text = '';
  const answer = new Promise<string>((resolve) => {
    socket.on('data', (c) => { text += c.toString('latin1'); if (text.includes('\r\n\r\n')) resolve(text); });
    socket.on('error', () => resolve(text));
    socket.on('close', () => resolve(text));
  });
  socket.write(`POST ${PREVIEW} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\nX-Mahlwerk-Request: 1\r\n`
    + (user ? `Remote-User: ${user}\r\n` : '') + `Content-Length: ${length}\r\n\r\n`);
  socket.write(Buffer.alloc(sent, 0x78));
  return { socket, answer };
}

const within = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> =>
  Promise.race([p, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms))]);

test('an unauthenticated 30 MB upload is answered with 401 before its body is read', async () => {
  const w = await makeWorld({ on: false });
  worlds.push(w);
  const { socket, answer } = start(w, 30 * 1024 * 1024, 64 * 1024, null); // the rest of the 30 MB is never sent
  const head = await within(answer, 3000);
  socket.destroy();
  assert.notEqual(head, 'timeout', 'no answer while the client was still sending');
  assert.match(head as string, /^HTTP\/1\.1 401 /);
  assert.match(head as string, /\r\nconnection: close\r\n/i);
});

test('at most two large uploads are read at the same time; an aborted one frees its slot', async () => {
  const w = await makeWorld({ on: false });
  worlds.push(w);
  const big = 2 * 1024 * 1024;
  const first = start(w, big, 1024, 'ann');
  const second = start(w, big, 1024, 'ben');
  await new Promise((r) => setTimeout(r, 300)); // both are past the sign-in and reading their bodies
  const third = start(w, big, 1024, 'ann');
  const head = await within(third.answer, 3000);
  third.socket.destroy();
  assert.match(String(head), /^HTTP\/1\.1 429 /);
  assert.match(String(head), /\r\nretry-after: 5\r\n/i);
  // a small body needs no slot
  const small = await fetch(`http://127.0.0.1:${w.port}${PREVIEW}`, { method: 'POST', body: 'x', headers: { 'remote-user': 'ann', 'x-mahlwerk-request': '1', 'content-type': 'application/octet-stream' } });
  assert.equal(small.status, 422);
  first.socket.destroy();
  second.socket.destroy();
  await new Promise((r) => setTimeout(r, 300));
  const res = await fetch(`http://127.0.0.1:${w.port}${PREVIEW}`, { method: 'POST', body: new Uint8Array(big), headers: { 'remote-user': 'ann', 'x-mahlwerk-request': '1', 'content-type': 'application/octet-stream' } });
  assert.equal(res.status, 422); // read in full and refused by the import (no export), not 429
});
