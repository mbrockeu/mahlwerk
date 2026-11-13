"""Brake against guessing passwords. The rule and why it looks like this:

Two kinds of keys block hard (HTTP 429 before the password is even looked at):
  * the client address (IPv6 counted as a /64 network), and
  * the pair user name + client address.
From the 5th failure of a key it is blocked for 2**(failures - 4) seconds (2, 4, 8 ... at most 15 minutes).

A third counter, the user name alone, NEVER blocks: if it did, anybody could keep a stranger's account locked just by
typing the name wrong from anywhere (and a distributed attack would lock the owner out too). Instead, while a name has
seen 5 or more failures in the last 15 minutes ("under pressure"), attempts for that name are checked one at a time
and a failed one takes at least a second (`PRESSURE_DELAY`), so a guess rate of about one per second per name is the
ceiling however many addresses the attacker has. The right password is always checked and always lets the owner in;
the worst they see is a short wait (if the queue of checks for the name is full they get 429 for a few seconds).

The state lives in the memory of this process: a restart forgets it, and with several worker processes each has its
own counts (run one worker). The clock is injectable so that tests do not sleep.
"""

import threading
import time
from collections.abc import Callable

FREE = 4  # failures without delay
MAX_DELAY = 900  # seconds
FORGET_AFTER = 3600  # a key that failed this long ago starts again at zero
PRESSURE_AFTER = 5  # failures of one name within PRESSURE_WINDOW make it "under pressure"
PRESSURE_WINDOW = 900
PRESSURE_DELAY = 1.0  # a failed check of a name under pressure lasts at least this long
QUEUE_WAIT = 5.0  # how long a check waits for its turn before it gets 429
MAX_KEYS = 20000  # bound on memory; the oldest keys are dropped when exceeded


class LoginThrottle:
    def __init__(self, clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep):
        self.clock = clock
        self.sleep = sleep
        self._lock = threading.Lock()
        self._state: dict[str, list[float]] = {}  # key -> [failures, blocked_until, last_failure]
        self._names: dict[str, threading.Lock] = {}

    def wait(self, *keys: str) -> int:
        """Seconds the caller must still wait (0 = may try)."""
        now = self.clock()
        with self._lock:
            left = max((self._state[k][1] - now for k in keys if k in self._state), default=0)
        return max(0, int(left) + (1 if left > int(left) else 0))

    def _bump(self, key: str, now: float, block: bool) -> None:
        count, _, last = self._state.get(key, [0, 0.0, 0.0])
        if now - last > (FORGET_AFTER if block else PRESSURE_WINDOW):
            count = 0
        count += 1
        delay = min(MAX_DELAY, 2 ** (count - FREE)) if block and count > FREE else 0
        self._state[key] = [count, now + delay, now]

    def fail(self, *keys: str, name: str | None = None) -> None:
        """Count a failure for the blocking keys and, if given, for the user name (which never blocks)."""
        now = self.clock()
        with self._lock:
            for key in keys:
                self._bump(key, now, block=True)
            if name is not None:
                self._bump("n:" + name, now, block=False)
            if len(self._state) > MAX_KEYS:
                for key in sorted(self._state, key=lambda k: self._state[k][2])[: MAX_KEYS // 4]:
                    del self._state[key]

    def success(self, *keys: str) -> None:
        with self._lock:
            for key in keys:
                self._state.pop(key, None)

    def under_pressure(self, name: str) -> bool:
        now = self.clock()
        with self._lock:
            state = self._state.get("n:" + name)
        return state is not None and state[0] >= PRESSURE_AFTER and now - state[2] <= PRESSURE_WINDOW

    def name_turn(self, name: str) -> threading.Lock:
        """The lock that serialises the checks of one name under pressure."""
        with self._lock:
            return self._names.setdefault(name, threading.Lock())
