// engine/agents/rng.js — E6: the deterministic RNG for the fast agent clock.
//
// "Everything is an agent" means hundreds of fast agents may make stochastic
// decisions per tick (a state machine's weighted branch, an RL policy's
// exploration, a civilian's panic). For the simulation to be reproducible the
// randomness MUST be seeded and owned by the engine, never `Math.random()`.
// This module is that single stable stream — the same `mulberry32` game sims
// already proved deterministic across engines/runs.
//
// Determinism contract (mirrors the idle-continue decision): reasoning guards
// are PURE functions. Time is NEVER read from Date.now()/performance.now()
// inside a guard — it arrives explicitly as ctx.t / ctx.dt. Randomness arrives
// as ctx.rng (a mulberry32 draw). So one tick is a pure function of
// (agent.state, observation, ctx.t, ctx.dt, ctx.rng) — replayable by reseeding.
//
// Dependency-free ESM: runs in the core worker (no browser APIs) and in plain
// Node (headless validation) alike.

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit seeded PRNG.
 * Returns a function drawing the next value in [0, 1). Stable across engines:
 * same seed => same stream. (Identical across engines/runs, on purpose.)
 */
export function mulberry32(seed) {
  let a = (Number.isFinite(seed) ? seed : 1) >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic element pick: draw once, index once. Empty/absent => undefined. */
export function pick(rng, arr) {
  if (!arr || !arr.length) return undefined;
  const i = Math.min(arr.length - 1, Math.floor(rng() * arr.length));
  return arr[i];
}

/** Deterministic uniform draw in [lo, hi). */
export function range(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

/** Deterministic integer draw in [lo, hi] inclusive. */
export function intRange(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Derive a stable child seed from a parent seed + a string/id, so each agent
 * can own an independent-but-reproducible stream without threading one global
 * rng through everything. FNV-1a hash, folded into a 32-bit int.
 */
export function deriveSeed(parentSeed, key) {
  let h = (Number.isFinite(parentSeed) ? parentSeed : 1) >>> 0;
  const s = String(key == null ? '' : key);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
