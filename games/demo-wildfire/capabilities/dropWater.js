// games/demo-wildfire/capabilities/dropWater.js — PACKAGE actuator (pure JS).
//
// Water suppression. This is DOMAIN CONTENT: the engine knows nothing of water,
// fire, or drones — it only knows that an archetype may own a capability named
// 'dropWater' and route intents to it through the validate/clamp/gate/apply
// pipeline. The actuator reaches the fire environment through the generic world
// layer (ctx.world.getLayer('environment')) and delegates to its sim.
//
// Semantics (the package's choice): water flips BURNING -> WET and soaks
// UNBURNED fuel, leaving lingering wet cells that steam before settling.
//
// One rule: no browser APIs. It mutates package state and emits an engine-owned
// effect BY NAME ('waterDrop'); the engine's L2 layer renders it.

const DEFAULT_RADIUS_M = 400;

function envOf(ctx) {
  return ctx?.world?.getLayer?.('environment') || null;
}

export const dropWater = {
  name: 'dropWater',
  kind: 'actuator',
  schema: { lon: 'number?', lat: 'number?', radiusM: 'number?' },

  // Spatial gate: keep the drop inside the playable world.
  clamp: (intent, ctx) => {
    const w = ctx?.world;
    if (!w || typeof w.clamp !== 'function') return intent;
    if (!Number.isFinite(intent.lon) || !Number.isFinite(intent.lat)) return intent;
    const c = w.clamp(intent.lon, intent.lat);
    return { ...intent, lon: c.lon, lat: c.lat };
  },

  // Legality gate: the environment must exist; honor a payload budget if the
  // archetype tracks one (state.payload), else unlimited (thin flagship).
  gate: (agent, intent, ctx) => {
    const env = envOf(ctx);
    if (!env || !env.sim) return { ok: false, reason: 'no fire environment' };
    if (Number.isFinite(agent.state?.payload) && agent.state.payload <= 0) {
      return { ok: false, reason: 'payload empty' };
    }
    return { ok: true };
  },

  invoke(agent, ctx, intent) {
    const env = envOf(ctx);
    const pose = agent.state?.pose;
    const lon = Number.isFinite(intent.lon) ? intent.lon : pose?.lon;
    const lat = Number.isFinite(intent.lat) ? intent.lat : pose?.lat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { ok: false, reason: 'no target' };
    const radiusM = Number.isFinite(intent.radiusM) ? intent.radiusM : DEFAULT_RADIUS_M;
    env.sim.dropWater(lon, lat, radiusM);
    if (Number.isFinite(agent.state?.payload)) agent.state.payload -= 1;
    ctx.emit?.({ kind: 'effect', effect: 'waterDrop', by: agent.id, lon, lat, params: { radiusM }, t: ctx.t });
    return { ok: true, lon, lat, radiusM };
  },

  tool: {
    description: 'Drop water on a location to suppress fire (leaves lingering wet cells).',
    parameters: { type: 'object', properties: { lon: { type: 'number' }, lat: { type: 'number' }, radiusM: { type: 'number' } }, required: [] },
  },
};

export default dropWater;
