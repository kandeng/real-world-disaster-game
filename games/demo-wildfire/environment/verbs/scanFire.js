// games/demo-wildfire/capabilities/scanFire.js — PACKAGE sensor (pure JS).
//
// Reads the fire environment and folds it into an observation fragment the
// package's state machines understand. The engine only knows "an archetype may
// own a sensor named 'scanFire'"; the MEANING of every field below is domain
// content. It reaches the environment through the generic world layer and reads
// its OPAQUE snapshot()/hotspot()/cellAt() — the engine never interprets them.
//
// Observation shape returned:
//   { fire: { phase, burning, occupyFrac, lost, wind, cellHere,
//             hotspot: { lon, lat, burning, distM } | null } }
// `hotspot.distM` is computed HERE (package-owned haversine) so a drone's SM can
// switch between "fly to the fire" and "suppress it" without importing the
// engine's geo helpers — a package imports nothing from the engine (one rule).

const DEG2RAD = Math.PI / 180;

/** Great-circle distance in metres between two {lon,lat} points. */
function haversineM(a, b) {
  if (!a || !b) return Infinity;
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLon = (b.lon - a.lon) * DEG2RAD;
  const la = a.lat * DEG2RAD, lb = b.lat * DEG2RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * 6371000;
}

export const scanFire = {
  name: 'scanFire',
  kind: 'sensor',
  invoke(agent, ctx, params = {}) {
    const env = ctx?.world?.getLayer?.('environment');
    if (!env || typeof env.snapshot !== 'function') return { fire: null };
    const st = env.snapshot() || {};
    const pose = agent?.state?.pose || null;

    let hs = typeof env.hotspot === 'function' ? env.hotspot() : null;
    let hotspot = null;
    if (hs && Number.isFinite(hs.lon) && Number.isFinite(hs.lat)) {
      hotspot = { lon: hs.lon, lat: hs.lat, burning: hs.burning ?? 0 };
      if (pose) hotspot.distM = haversineM(pose, hotspot);
    }

    // Opaque cell value under the agent (the SM interprets it; CELL.BURNING===1
    // by this package's convention). null off-grid.
    const cellHere = (pose && typeof env.cellAt === 'function') ? env.cellAt(pose.lon, pose.lat) : null;

    return {
      fire: {
        phase: st.phase ?? null,
        burning: st.counts?.burning ?? 0,
        occupyFrac: st.occupyFrac ?? 0,
        lost: !!st.lost,
        wind: st.wind ?? null,
        cellHere,
        hotspot,
        // Convenience metric for guards: how far to the nearest burning cell.
        hotspotDistM: hotspot && Number.isFinite(hotspot.distM) ? hotspot.distM : Infinity,
        radiusM: Number.isFinite(params.radiusM) ? params.radiusM : null,
      },
    };
  },
};

export { haversineM };
export default scanFire;
