export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function nextSeed(seed: number): number {
  const rng = mulberry32(seed);
  rng();
  return (seed * 1664525 + 1013904223) >>> 0;
}

export function rand(seed: number): { v: number; seed: number } {
  const rng = mulberry32(seed);
  const v = rng();
  const nseed = ((seed * 1664525 + 1013904223) >>> 0) ^ Math.floor(v * 0xffffffff);
  return { v, seed: nseed >>> 0 };
}

export function randRange(seed: number, lo: number, hi: number) {
  const r = rand(seed);
  return { v: lo + r.v * (hi - lo), seed: r.seed };
}

export function randInt(seed: number, lo: number, hi: number) {
  const r = rand(seed);
  return { v: Math.floor(lo + r.v * (hi - lo + 1)), seed: r.seed };
}

export function pick<T>(seed: number, arr: readonly T[]): { v: T; seed: number } {
  const r = randInt(seed, 0, arr.length - 1);
  return { v: arr[r.v], seed: r.seed };
}

export function gaussian(seed: number): { v: number; seed: number } {
  const r1 = rand(seed);
  const r2 = rand(r1.seed);
  const u = Math.max(1e-9, r1.v);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r2.v);
  return { v: z, seed: r2.seed };
}
