// Python's `random.Random(str)`: Mersenne Twister seeded the way CPython does it, with the methods the demo data uses
// (random, randrange, randint, uniform, gauss, choice, sample). The same seed gives the same numbers as Python, so the demo
// data of a user does not change when the backend switches. Seeding hashes with SHA-512 (WebCrypto, hence async).

const N = 624, M = 397;

export class PyRandom {
  private mt = new Uint32Array(N);
  private index = N;
  private gaussNext: number | null = null;

  private constructor() {}

  /** random.Random(seed) for a str seed (version 2: the text's bytes followed by their SHA-512 digest, as a big number). */
  static async seeded(seed: string): Promise<PyRandom> {
    const text = new TextEncoder().encode(seed);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', text));
    const be = new Uint8Array(text.length + digest.length);
    be.set(text);
    be.set(digest, text.length);
    // little-endian 32-bit words of the number (leading zero bytes of the big-endian form do not count)
    let start = 0;
    while (start < be.length - 1 && be[start] === 0) start++;
    const used = be.length - start;
    const words = Math.ceil(used / 4);
    const key = new Uint32Array(words);
    for (let i = 0; i < used; i++) key[i >> 2] |= be[be.length - 1 - i] << (8 * (i & 3));
    const rng = new PyRandom();
    rng.initByArray(key);
    return rng;
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
    this.index = N;
  }

  private initByArray(key: Uint32Array): void {
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1, j = 0;
    for (let k = Math.max(N, key.length); k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
    this.index = N;
  }

  private genrand(): number {
    const mt = this.mt;
    if (this.index >= N) {
      let kk = 0;
      const mix = (a: number, b: number) => (((a & 0x80000000) | (b & 0x7fffffff)) >>> 0);
      const twist = (y: number) => (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      for (; kk < N - M; kk++) mt[kk] = (mt[kk + M] ^ twist(mix(mt[kk], mt[kk + 1]))) >>> 0;
      for (; kk < N - 1; kk++) mt[kk] = (mt[kk + M - N] ^ twist(mix(mt[kk], mt[kk + 1]))) >>> 0;
      mt[N - 1] = (mt[M - 1] ^ twist(mix(mt[N - 1], mt[0]))) >>> 0;
      this.index = 0;
    }
    let y = mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** A float in [0, 1) with 53 random bits. */
  random(): number {
    const a = this.genrand() >>> 5, b = this.genrand() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** k random bits (k <= 32 is all the demo needs). */
  getrandbits(k: number): number {
    if (k <= 0 || k > 32) throw new RangeError('getrandbits: 1..32 bits');
    return this.genrand() >>> (32 - k);
  }

  private randbelow(n: number): number {
    if (!n) return 0;
    const k = n.toString(2).length;
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** randrange(start, stop, step): stop undefined means randrange(start) = [0, start). */
  randrange(start: number, stop?: number, step = 1): number {
    if (stop === undefined) {
      if (start > 0) return this.randbelow(start);
      throw new RangeError('empty range for randrange()');
    }
    const width = stop - start;
    if (step === 1) {
      if (width > 0) return start + this.randbelow(width);
      throw new RangeError(`empty range in randrange(${start}, ${stop})`);
    }
    const n = step > 0 ? Math.floor((width + step - 1) / step) : Math.floor((width + step + 1) / step);
    if (!step || n <= 0) throw new RangeError('empty range in randrange()');
    return start + step * this.randbelow(n);
  }

  randint(a: number, b: number): number { return this.randrange(a, b + 1); }

  uniform(a: number, b: number): number { return a + (b - a) * this.random(); }

  gauss(mu = 0.0, sigma = 1.0): number {
    let z = this.gaussNext;
    this.gaussNext = null;
    if (z === null) {
      const x2pi = this.random() * (2 * Math.PI);
      const g2rad = Math.sqrt(-2.0 * Math.log(1.0 - this.random()));
      z = Math.cos(x2pi) * g2rad;
      this.gaussNext = Math.sin(x2pi) * g2rad;
    }
    return mu + z * sigma;
  }

  choice<T>(seq: readonly T[]): T { return seq[this.randbelow(seq.length)]; }

  /** k unique elements in selection order (the two strategies of CPython: a pool for small populations, a set otherwise). */
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (!(k >= 0 && k <= n)) throw new RangeError('Sample larger than population or is negative');
    const result: T[] = new Array(k);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = [...population];
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
    } else {
      const selected = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (selected.has(j)) j = this.randbelow(n);
        selected.add(j);
        result[i] = population[j];
      }
    }
    return result;
  }
}
