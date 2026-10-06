// engine/agents/world/worldModel.js — E6.2: the generic geospatial world model.
//
// The engine's domain-agnostic container for everything that ISN'T an agent's
// private memory:
//   • the roster (agents + byId);
//   • a uniform-grid SPATIAL HASH so neighbor queries stay ~O(1) and hundreds
//     of fast agents scale (the plan's "scale to 100s" requirement);
//   • the world BOUNDS — the intent pipeline's spatial gate (a moveTo target or
//     a commander order can never leave the authored world);
//   • named environment LAYERS — the package's sim (e.g. a fire CA) attached
//     OPAQUELY; the engine never inspects its domain (see world/environment.js).
//
// Pure, dependency-free ESM: runs in the core worker and headless Node alike.
// Geometry reuses geo.js's flat-earth approximation (fine at the neighborhood
// play scale). Deterministic: no wall-clock, no Math.random.

import { distanceM, clampToBounds, metersPerDegLon, METERS_PER_DEG_LAT } from '../geo.js';

export function createWorldModel(options = {}) {
  const cellSizeM = Number.isFinite(options.cellSizeM) && options.cellSizeM > 0 ? options.cellSizeM : 250;
  let bounds = options.bounds && typeof options.bounds === 'object' ? options.bounds : null;

  const agents = [];
  const byId = new Map();
  const layers = new Map();      // name -> opaque layer (e.g. the 'environment')
  const buckets = new Map();     // "bx:by" -> Set<agent>

  function bucketOf(lon, lat) {
    const x = (Number(lon) || 0) * metersPerDegLon(lat);
    const y = (Number(lat) || 0) * METERS_PER_DEG_LAT;
    return `${Math.floor(x / cellSizeM)}:${Math.floor(y / cellSizeM)}`;
  }

  function addToBucket(agent) {
    const p = agent.state?.pose;
    if (!p) { agent._bucket = null; return; }
    const k = bucketOf(p.lon, p.lat);
    agent._bucket = k;
    let set = buckets.get(k);
    if (!set) { set = new Set(); buckets.set(k, set); }
    set.add(agent);
  }

  function removeFromBucket(agent) {
    const k = agent._bucket;
    if (k == null) return;
    const set = buckets.get(k);
    if (set) { set.delete(agent); if (!set.size) buckets.delete(k); }
    agent._bucket = null;
  }

  function add(agent) {
    if (!agent || typeof agent.id !== 'string' || byId.has(agent.id)) return false;
    agents.push(agent);
    byId.set(agent.id, agent);
    addToBucket(agent);
    return true;
  }

  function remove(id) {
    const agent = byId.get(id);
    if (!agent) return false;
    removeFromBucket(agent);
    byId.delete(id);
    const i = agents.indexOf(agent);
    if (i >= 0) agents.splice(i, 1);
    return true;
  }

  /** Re-bucket an agent after its pose changed (a moveTo). Cheap. */
  function rebucket(agent) {
    if (!agent) return;
    removeFromBucket(agent);
    addToBucket(agent);
  }

  function get(id) { return byId.get(id) || null; }

  /**
   * Neighbor query via the spatial hash: scan the bucket ring covering radiusM,
   * then exact-filter by distance. Returns [{ agent, distM }] sorted near->far.
   * `filter(agent)` optionally excludes (e.g. by archetype). The ring is at
   * least 1 bucket wide, so the tiny cos(lat) drift between the query latitude
   * and an agent's latitude can never miss a neighbor at play scale.
   */
  function query(lon, lat, radiusM, filter) {
    const out = [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return out;
    const r = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : 0;
    const ring = Math.max(1, Math.ceil(r / cellSizeM));
    const cx = Math.floor((lon * metersPerDegLon(lat)) / cellSizeM);
    const cy = Math.floor((lat * METERS_PER_DEG_LAT) / cellSizeM);
    const from = { lon, lat };
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const set = buckets.get(`${cx + dx}:${cy + dy}`);
        if (!set) continue;
        for (const agent of set) {
          if (!agent.alive) continue;
          if (filter && !filter(agent)) continue;
          const p = agent.state?.pose;
          if (!p) continue;
          const d = distanceM(from, p);
          if (d <= r) out.push({ agent, distM: d });
        }
      }
    }
    out.sort((a, b) => a.distM - b.distM);
    return out;
  }

  function setBounds(b) { bounds = b && typeof b === 'object' ? b : null; }
  function clamp(lon, lat) { return clampToBounds(lon, lat, bounds); }
  function setLayer(name, layer) { layers.set(name, layer); }
  function getLayer(name) { return layers.get(name) || null; }
  function hasLayer(name) { return layers.has(name); }

  return {
    get agents() { return agents; },
    get bounds() { return bounds; },
    get cellSizeM() { return cellSizeM; },
    get size() { return agents.length; },
    add, remove, rebucket, get, query,
    setBounds, clamp, setLayer, getLayer, hasLayer,
  };
}
