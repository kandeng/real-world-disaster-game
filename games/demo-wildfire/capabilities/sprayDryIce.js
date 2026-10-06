// games/demo-wildfire/capabilities/sprayDryIce.js — PACKAGE actuator (pure JS).
//
// Dry-ice suppression: the SECOND suppression mode, and the flagship's proof of
// the separation litmus. Adding it touched ONLY this package (a new capability
// file + a new sim method); NO engine file changed. The engine still only knows
// "an archetype may own an actuator named 'sprayDryIce'".
//
// Semantics differ from water on purpose (the package's choice): dry ice is a
// fast knockdown/smother — a BURNING cell goes straight to ASH, with no
// lingering WET/steam phase, and unburned fuel is not soaked.
//
// One rule: no browser APIs; emits an engine-owned effect BY NAME ('dryIceSpray').

const DEFAULT_RADIUS_M = 300;

function envOf(ctx) {
  return ctx?.world?.getLayer?.('environment') || null;
}

export const sprayDryIce = {
  name: 'sprayDryIce',
  kind: 'actuator',
  schema: { lon: 'number?', lat: 'number?', radiusM: 'number?' },

  clamp: (intent, ctx) => {
    const w = ctx?.world;
    if (!w || typeof w.clamp !== 'function') return intent;
    if (!Number.isFinite(intent.lon) || !Number.isFinite(intent.lat)) return intent;
    const c = w.clamp(intent.lon, intent.lat);
    return { ...intent, lon: c.lon, lat: c.lat };
  },

  gate: (agent, intent, ctx) => {
    const env = envOf(ctx);
    if (!env || !env.sim) return { ok: false, reason: 'no fire environment' };
    if (typeof env.sim.sprayDryIce !== 'function') return { ok: false, reason: 'environment cannot spray dry ice' };
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
    env.sim.sprayDryIce(lon, lat, radiusM);
    if (Number.isFinite(agent.state?.payload)) agent.state.payload -= 1;
    ctx.emit?.({ kind: 'effect', effect: 'dryIceSpray', by: agent.id, lon, lat, params: { radiusM }, t: ctx.t });
    return { ok: true, lon, lat, radiusM };
  },

  tool: {
    description: 'Spray dry ice on a location for fast fire knockdown (smothers burning cells to ash).',
    parameters: { type: 'object', properties: { lon: { type: 'number' }, lat: { type: 'number' }, radiusM: { type: 'number' } }, required: [] },
  },
};

export default sprayDryIce;
