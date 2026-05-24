import { rand } from "../../rng";

// Knuth's Poisson sampler. Fine for the small λ values used in flow.ts
// (λ ≤ ~4); the iteration cap of 50 is a paranoia guard.
export function poisson(seed: number, lambda: number): { v: number; seed: number } {
  if (lambda <= 0) return { v: 0, seed };
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  let s = seed;
  while (k < 50) {
    const r = rand(s);
    s = r.seed;
    p *= r.v;
    if (p <= L) return { v: k, seed: s };
    k++;
  }
  return { v: k, seed: s };
}

// Weighted pick from a record of positive weights. Assumes at least one
// weight is > 0 (callers control the WEIGHTS table). Falls back to the
// last key if numerical drift puts target past the accumulator.
export function weightedPick<K extends string>(
  seed: number,
  weights: Record<K, number>,
): { v: K; seed: number } {
  const entries = Object.entries(weights) as [K, number][];
  let total = 0;
  for (const [, w] of entries) total += w;
  const r = rand(seed);
  if (total <= 0) {
    return { v: entries[0][0], seed: r.seed };
  }
  const target = r.v * total;
  let acc = 0;
  for (const [k, w] of entries) {
    acc += w;
    if (target <= acc) return { v: k, seed: r.seed };
  }
  return { v: entries[entries.length - 1][0], seed: r.seed };
}
