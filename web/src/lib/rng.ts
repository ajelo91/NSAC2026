/** PRNG determinístico (mulberry32) y distribuciones auxiliares para el mock. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export function normal(rng: Rng, mean = 0, sd = 1): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function lognormal(rng: Rng, mu: number, sigma: number): number {
  return Math.exp(normal(rng, mu, sigma));
}

export function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 60) return Math.max(0, Math.round(normal(rng, lambda, Math.sqrt(lambda))));
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > l);
  return k - 1;
}

export function uniform(rng: Rng, a: number, b: number): number {
  return a + (b - a) * rng();
}

export function weightedIndex(rng: Rng, weights: number[]): number {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** Ruido determinístico U[0,1) a partir de enteros (misma celda/mes ⇒ mismo valor). */
export function hash01(...keys: number[]): number {
  let h = 2166136261 >>> 0;
  for (const k of keys) {
    let x = (Math.trunc(k) | 0) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    h = Math.imul(h ^ x, 16777619) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, d = 1) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
