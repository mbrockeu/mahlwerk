// Runs the picture child (imageproc.py `_run_child`): one child at a time, at most MAX_WAITING more requests wait for their turn, a
// wall-clock limit, and the limits the operating system enforces where the system offers them (prlimit: CPU time,
// no core dumps, no files written, few descriptors; an own empty network and user namespace by `unshare`; both silently skipped when missing).
// Not carried over from the Python child: RLIMIT_NPROC 0 (Node needs threads) and the 768 MB address space (RLIMIT_AS: the TypeScript
// loader of Node alone needs more than 8 GiB of address space for its WebAssembly, V8 and libvips reserve far more than they use; a
// 24 megapixel picture peaks at ~180 MB resident). What bounds memory instead: the checks of `imageChild.ts` (24 megapixels, 300 MB of
// decoded pixels, first frame only, one child at a time), `--max-old-space-size`, and the wall clock. A build that ships the child as
// plain JavaScript can add `--as=` here. The child is a fresh process with an empty environment, `/` as
// working directory and nothing inherited but stdin/stdout/stderr. If it is killed, crashes in a library or times out, the answer is a
// plain refusal, never an error page and never a hung server.
import { spawn, spawnSync } from 'node:child_process';
import { ImageRejected, type ImageRunner } from '../core/imageproc.ts';

const MAX_WAITING = 2;
const WALL_SECONDS = 30;
const WAIT_FOR_TURN = 5;
const CPU_SECONDS = 20;
const CHILD = new URL('./imageChild.ts', import.meta.url).pathname;
const KINDS = ['format', 'too_large', 'too_many_pixels', 'broken', 'busy', 'unavailable'];

const available = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
let wrapper: string[] | undefined;

/** The command prefix that reduces what the child may do, as far as this system allows it. */
function wrap(): string[] {
  if (wrapper) return wrapper;
  const prefix: string[] = [];
  if (available('unshare', ['--user', '--net', '--map-root-user', 'true'])) prefix.push('unshare', '--user', '--net', '--map-root-user');
  if (available('prlimit', ['--cpu=5', 'true'])) prefix.push('prlimit', `--cpu=${CPU_SECONDS}`, '--core=0', '--fsize=0', '--nofile=256');
  return (wrapper = prefix);
}

export function nodeImageRunner(): ImageRunner {
  let running = false;
  let queued = 0;
  const turns: (() => void)[] = [];

  const takeTurn = (): Promise<boolean> => {
    if (!running) { running = true; return Promise.resolve(true); }
    return new Promise((resolve) => {
      const t = setTimeout(() => { turns.splice(turns.indexOf(go), 1); resolve(false); }, WAIT_FOR_TURN * 1000);
      const go = () => { clearTimeout(t); resolve(true); }; // the one that ends hands its turn over: `running` stays true
      turns.push(go);
    });
  };
  const giveTurn = () => { const next = turns.shift(); if (next) next(); else running = false; };

  return {
    async run(data, mode) {
      if (queued >= 1 + MAX_WAITING) throw new ImageRejected('busy'); // one running and at most MAX_WAITING waiting; the rest is refused without waiting
      queued++;
      try {
        if (!(await takeTurn())) throw new ImageRejected('busy');
        try {
          return await spawnChild(data, mode);
        } finally {
          giveTurn();
        }
      } finally {
        queued--;
      }
    },
  };
}

function spawnChild(data: Uint8Array, mode: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const [cmd, ...pre] = [...wrap(), process.execPath];
    let child;
    try {
      child = spawn(cmd!, [...pre, '--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--max-old-space-size=512', CHILD, mode], {
        cwd: '/', env: { PATH: process.env.PATH ?? '', MAHLWERK_IMAGE_CHILD: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return reject(new ImageRejected('unavailable'));
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new ImageRejected('broken')); }, WALL_SECONDS * 1000);
    let done = false;
    const finish = (r: Uint8Array | ImageRejected) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (r instanceof ImageRejected) reject(r); else resolve(r);
    };
    child.stdout.on('data', (c: Buffer) => { outSize += c.length; if (outSize > 4 * 1024 * 1024) { child.kill('SIGKILL'); finish(new ImageRejected('broken')); } else out.push(c); });
    child.stderr.on('data', (c: Buffer) => { if (err.length < 8) err.push(c); });
    child.on('error', () => finish(new ImageRejected('unavailable')));
    child.on('close', (code) => {
      if (code === 0) return finish(new Uint8Array(Buffer.concat(out)));
      const kind = Buffer.concat(err).toString('ascii').trim().split('\n').pop() ?? 'broken';
      finish(new ImageRejected((KINDS.includes(kind) ? kind : 'broken') as any));
    });
    child.stdin.on('error', () => {}); // a child that ends before it read everything
    child.stdin.end(data);
  });
}
