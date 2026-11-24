// Brake against guessing passwords (throttle.py). The rule and why it looks like this:
//
// Two kinds of keys block hard (HTTP 429 before the password is even looked at): the client address (IPv6 counted as a /64
// network), and the pair user name + client address. From the 5th failure of a key it is blocked for 2**(failures - 4) seconds
// (2, 4, 8 ... at most 15 minutes).
//
// A third counter, the user name alone, NEVER blocks: if it did, anybody could keep a stranger's account locked just by typing
// the name wrong from anywhere. Instead, while a name has seen 5 or more failures in the last 15 minutes ("under pressure"),
// attempts for that name are checked one at a time and a failed one takes at least a second (PRESSURE_DELAY), so a guess rate of
// about one per second per name is the ceiling however many addresses the attacker has. The right password is always checked
// and always lets the owner in; the worst they see is a short wait (if the queue of checks for the name is full they get 429).
//
// The state lives in the memory of this process: a restart forgets it. The clock is injectable so that tests do not sleep.

export const FREE = 4; // failures without delay
const MAX_DELAY = 900; // seconds
const FORGET_AFTER = 3600; // a key that failed this long ago starts again at zero
const PRESSURE_AFTER = 5; // failures of one name within PRESSURE_WINDOW make it "under pressure"
const PRESSURE_WINDOW = 900;
export const PRESSURE_DELAY = 1.0; // a failed check of a name under pressure lasts at least this long (seconds)
export const QUEUE_WAIT = 5.0; // how long a check waits for its turn before it gets 429 (seconds)
const MAX_KEYS = 20000; // bound on memory; the oldest keys are dropped when exceeded

/** threading.Lock with `acquire(timeout=)`: one holder at a time, the others queue. */
export class Turn {
  private held = false;
  private queue: (() => void)[] = [];

  /** true when the turn is ours, false after `timeoutSeconds` of waiting. */
  acquire(timeoutSeconds: number): Promise<boolean> {
    if (!this.held) { this.held = true; return Promise.resolve(true); }
    return new Promise((resolve) => {
      const grant = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((q) => q !== grant);
        resolve(false);
      }, timeoutSeconds * 1000);
      this.queue.push(grant);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next(); else this.held = false;
  }
}

type State = [count: number, blockedUntil: number, last: number];

export class LoginThrottle {
  private clock: () => number;
  sleep: (seconds: number) => Promise<void>;
  private state = new Map<string, State>();
  private names = new Map<string, Turn>();

  constructor(clock: () => number, sleep: (seconds: number) => Promise<void> = (s) => new Promise((r) => setTimeout(r, s * 1000))) {
    this.clock = clock;
    this.sleep = sleep;
  }

  /** Seconds the caller must still wait (0 = may try). */
  wait(...keys: string[]): number {
    const now = this.clock();
    let left = 0;
    for (const k of keys) { const s = this.state.get(k); if (s) left = Math.max(left, s[1] - now); }
    return Math.max(0, Math.trunc(left) + (left > Math.trunc(left) ? 1 : 0));
  }

  private bump(key: string, now: number, block: boolean): void {
    let [count, , last] = this.state.get(key) ?? [0, 0, 0];
    if (now - last > (block ? FORGET_AFTER : PRESSURE_WINDOW)) count = 0;
    count += 1;
    const delay = block && count > FREE ? Math.min(MAX_DELAY, 2 ** (count - FREE)) : 0;
    this.state.set(key, [count, now + delay, now]);
  }

  /** Count a failure for the blocking keys and, if given, for the user name (which never blocks). */
  fail(keys: string[], name?: string): void {
    const now = this.clock();
    for (const key of keys) this.bump(key, now, true);
    if (name !== undefined) this.bump('n:' + name, now, false);
    if (this.state.size > MAX_KEYS) {
      const oldest = [...this.state.keys()].sort((a, b) => this.state.get(a)![2] - this.state.get(b)![2]).slice(0, Math.floor(MAX_KEYS / 4));
      for (const key of oldest) this.state.delete(key);
    }
  }

  success(...keys: string[]): void {
    for (const key of keys) this.state.delete(key);
  }

  underPressure(name: string): boolean {
    const now = this.clock();
    const state = this.state.get('n:' + name);
    return state !== undefined && state[0] >= PRESSURE_AFTER && now - state[2] <= PRESSURE_WINDOW;
  }

  /** The lock that serialises the checks of one name under pressure. */
  nameTurn(name: string): Turn {
    let turn = this.names.get(name);
    if (!turn) { turn = new Turn(); this.names.set(name, turn); }
    return turn;
  }
}
