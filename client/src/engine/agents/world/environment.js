// engine/agents/world/environment.js — E6.2: the generic environment adapter.
//
// A package's environment (the fire CA today; a flood, crowd, or traffic sim
// tomorrow) is PURE JS loaded at boot. The engine attaches it to the world
// WITHOUT ever naming the domain: it reads a minimal generic contract, applies
// the environment's bounds, registers its domain capabilities, stores it as the
// 'environment' layer, and ticks it before the agents each step. This is the
// "package environment loading" half of the separation contract — the engine
// owns the grid + spatial hash + tick ordering; the package owns the cells, the
// wind, the triggers.
//
// Generic environment contract (every field OPTIONAL — degrade never break):
//   {
//     bounds?: {lonMin,latMin,lonMax,latMax},   // the playable world extent
//     grid?:   {cols,rows,lonMin,latMax,cellDegLon,cellDegLat},  // cellGridOverlay + worldCellAt geometry
//     cellAt?(lon,lat): any,        // opaque cell state at a position
//     tick?(dt): void,              // advance one deterministic sim step
//     capabilities?: [descriptor],  // domain capabilities to register BY NAME
//     snapshot?(): any,             // for observation / rendering
//     cellFrame?(): {grid?, cells:[[index,value],...]} | null,
//                                   // E6.9: generic per-frame cell-grid deltas the
//                                   // runtime relays as 'agents.world' for the host
//                                   // cellGridOverlay. `value` is OPAQUE to the
//                                   // engine (the package maps value -> colour in
//                                   // render/bindings.js). Return null when nothing
//                                   // changed so the runtime stays silent.
//     dispose?(): void,
//   }
// The engine treats `cellAt`/`snapshot` results as OPAQUE: a package's state
// machine reads them back through worldCellAt and interprets them. The fire CA
// becomes one such environment; the engine code is identical for any other.

/**
 * Attach a package environment to a world + capability registry. Applies bounds,
 * registers the environment's domain capabilities, and stores it as the
 * 'environment' layer. Returns the environment, or null if unusable (degrade,
 * never break — a package authored for a newer engine still boots).
 */
export function attachEnvironment(world, registry, env) {
  if (!world || !env || typeof env !== 'object') return null;
  if (env.bounds && typeof env.bounds === 'object') world.setBounds(env.bounds);
  if (Array.isArray(env.capabilities) && registry && typeof registry.registerAll === 'function') {
    registry.registerAll(env.capabilities);
  }
  world.setLayer('environment', env);
  return env;
}

/**
 * Advance the environment layer (if it ticks). The runtime calls this once per
 * sim step, BEFORE the agents sense — so an agent always observes the
 * environment as of the start of its own beat (a stable, deterministic order).
 */
export function tickEnvironment(world, dt) {
  const env = world?.getLayer?.('environment');
  if (env && typeof env.tick === 'function') env.tick(dt);
}
