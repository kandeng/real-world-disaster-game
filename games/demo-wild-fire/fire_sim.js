// fire_sim.js — game-package component: wild-fire cellular automaton.
//
// Scope split (same contract family as controller_drone.js / controller_tank.js):
//   • This module OWNS the fire state: a lat/lon grid of cells clipped to a
//     perimeter polygon. States: UNBURNED (fuel), BURNING, ASH (burned out,
//     black scar), WET (water on it), NO_FUEL (outside perimeter / ocean).
//   • This module RENDERS nothing. Hosts read getState()/takeChanges() and
//     feed the engine effect catalog (burn-scar overlay, flame sprites,
//     steam puffs). takeChanges() returns exactly the cells that changed
//     since the previous call, so a renderer applies deltas, not full grids.
//
// Dynamics:
//   • Spread: each burning cell ignites its 8 neighbours with probability
//     rate * dt * fuel * windFactor(neighbour direction vs wind). Wind makes
//     growth anisotropic (Santa Ana runs fast downwind, crawls upwind).
//   • Burn-out: a burning cell exhausts its fuel after FUEL_DURATION_S and
//     becomes ASH — the black ashy residue.
//   • Water: dropWater() flips BURNING -> WET (steam phase, then ASH) and
//     soaks UNBURNED fuel -> WET (dries back to UNBURNED). Holes carved this
//     way leave ash patches inside a still-burning ring — a perimeter
//     polygon could never represent that; the grid can.
//   • Determinism: seeded PRNG, one stream per tick index. Same seed + same
//     command sequence => identical evolution (getState().gridHash proves it).
//
// Dependency-free ESM: runs in the browser (package URL import) and in Node
// (headless validation).

export const FIRE_SIM_API = 1;

export const CELL = { UNBURNED: 0, BURNING: 1, ASH: 2, WET: 3, NO_FUEL: 4 };

const METERS_PER_DEG_LAT = 111320;
const DEG2RAD = Math.PI / 180;

const SPREAD_RATE = 0.015;     // per-second ignition probability at factor 1
const FUEL_DURATION_S = 90;    // burn time of one cell at fuel multiplier 1
const STEAM_S = 20;            // wet cell steams this long before settling
const WIND_REF_MPS = 15;       // wind speed that yields full anisotropy

// 8 neighbours as (dCol, dRow, east, north) unit directions. Row 0 = north.
const NEIGHBORS = [
  [1, 0, 1, 0], [1, -1, 0.7071, 0.7071], [0, -1, 0, 1], [-1, -1, -0.7071, 0.7071],
  [-1, 0, -1, 0], [-1, 1, -0.7071, -0.7071], [0, 1, 0, -1], [1, 1, 0.7071, -0.7071],
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// mulberry32: tiny seeded PRNG, stable across engines.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pointInPolygon(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [li, ni] = poly[i], [lj, nj] = poly[j];
    if ((li > lat) !== (lj > lat) && lon < ((nj - ni) * (lat - li)) / (lj - li) + ni) inside = !inside;
  }
  return inside;
}

/**
 * createFireSim(config) -> sim
 * config: {
 *   perimeter:   [[lat, lon], ...] closed-ish polygon (ray-cast, no repeat needed)
 *   noFuelPolygons: optional array of polygons; cells inside ANY of them are
 *                NO_FUEL even if inside the perimeter (ocean bays, lakes,
 *                urban firebreaks). Fire cannot cross them.
 *   cellSizeM:   grid pitch, default 50
 *   seed:        integer, default 1
 *   wind:        { toDeg (compass direction wind blows TOWARD), speedMps }
 * }
 */
export function createFireSim(config = {}) {
  const poly = config.perimeter || [];
  if (poly.length < 3) throw new Error('fire_sim: perimeter needs >= 3 points');
  const noFuelPolys = (config.noFuelPolygons || []).filter((p) => p && p.length >= 3);
  const cellSizeM = Number.isFinite(config.cellSizeM) ? config.cellSizeM : 50;
  const seed = Number.isFinite(config.seed) ? config.seed : 1;
  const windToDeg = Number.isFinite(config.wind?.toDeg) ? config.wind.toDeg : 225;
  const windMps = Number.isFinite(config.wind?.speedMps) ? config.wind.speedMps : 8;

  const lats = poly.map((p) => p[0]);
  const lons = poly.map((p) => p[1]);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const latCenter = (latMin + latMax) / 2;
  const cellDegLat = cellSizeM / METERS_PER_DEG_LAT;
  const cellDegLon = cellSizeM / (METERS_PER_DEG_LAT * Math.cos(latCenter * DEG2RAD));
  const cols = Math.max(1, Math.ceil((lonMax - lonMin) / cellDegLon));
  const rows = Math.max(1, Math.ceil((latMax - latMin) / cellDegLat));

  const state = new Uint8Array(cols * rows);
  const fuel = new Float32Array(cols * rows);
  const age = new Float32Array(cols * rows);
  const wasBurning = new Uint8Array(cols * rows);
  const noise = mulberry32((seed ^ 0x9e3779b9) | 0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const lat = latMax - (r + 0.5) * cellDegLat;   // row 0 = north edge
      const lon = lonMin + (c + 0.5) * cellDegLon;
      if (pointInPolygon(lat, lon, poly)) {
        state[i] = CELL.UNBURNED;
        fuel[i] = 0.6 + noise() * 0.8;               // heterogeneous fuel load
      } else {
        state[i] = CELL.NO_FUEL;                     // ocean, town, firebreak
      }
      // Water mask wins over perimeter membership: a bay inside the disaster
      // zone polygon must never burn.
      if (state[i] === CELL.UNBURNED) {
        for (const wp of noFuelPolys) {
          if (pointInPolygon(lat, lon, wp)) { state[i] = CELL.NO_FUEL; fuel[i] = 0; break; }
        }
      }
    }
  }

  const windEast = Math.sin(windToDeg * DEG2RAD);
  const windNorth = Math.cos(windToDeg * DEG2RAD);
  const aniso = clamp(windMps / WIND_REF_MPS, 0, 1);

  let t = 0;
  let tickIndex = 0;
  let changes = { burning: [], ash: [], wet: [], unburned: [] };

  const idxAt = (lon, lat) => {
    const c = Math.floor((lon - lonMin) / cellDegLon);
    const r = Math.floor((latMax - lat) / cellDegLat);
    return c < 0 || c >= cols || r < 0 || r >= rows ? -1 : r * cols + c;
  };
  const mark = (i, next) => {
    state[i] = next;
    if (next === CELL.BURNING) changes.burning.push(i);
    else if (next === CELL.ASH) changes.ash.push(i);
    else if (next === CELL.WET) changes.wet.push(i);
    else if (next === CELL.UNBURNED) changes.unburned.push(i);
  };

  function cellsInRadius(lon, lat, radiusM) {
    const out = [];
    const rCells = Math.ceil(radiusM / cellSizeM);
    const i0 = idxAt(lon, lat);
    if (i0 < 0) return out;
    const c0 = i0 % cols, r0 = (i0 / cols) | 0;
    for (let r = r0 - rCells; r <= r0 + rCells; r++) {
      for (let c = c0 - rCells; c <= c0 + rCells; c++) {
        if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
        const dLat = ((r0 - r) * cellDegLat) * METERS_PER_DEG_LAT;
        const dLon = ((c - c0) * cellDegLon) * METERS_PER_DEG_LAT * Math.cos(latCenter * DEG2RAD);
        if (dLat * dLat + dLon * dLon <= radiusM * radiusM) out.push(r * cols + c);
      }
    }
    return out;
  }

  // ---- commands -------------------------------------------------------------
  function ignite(lon, lat, radiusM = cellSizeM) {
    for (const i of cellsInRadius(lon, lat, radiusM)) {
      if (state[i] === CELL.UNBURNED) { state[i] = CELL.BURNING; age[i] = 0; changes.burning.push(i); }
    }
    return getState();
  }

  function dropWater(lon, lat, radiusM = cellSizeM * 2) {
    for (const i of cellsInRadius(lon, lat, radiusM)) {
      if (state[i] === CELL.BURNING) { wasBurning[i] = 1; age[i] = 0; mark(i, CELL.WET); }
      else if (state[i] === CELL.UNBURNED) { wasBurning[i] = 0; age[i] = 0; mark(i, CELL.WET); }
    }
    return getState();
  }

  // ---- integration ----------------------------------------------------------
  function tick(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return getState();
    t += dt;
    tickIndex++;
    const rng = mulberry32((seed + Math.imul(tickIndex, 2654435761)) | 0);

    const burningAtStart = [];
    for (let i = 0; i < state.length; i++) if (state[i] === CELL.BURNING) burningAtStart.push(i);

    // Ageing: burn-out to ash, wet cells steam then settle.
    for (let i = 0; i < state.length; i++) {
      if (state[i] === CELL.BURNING) {
        age[i] += dt;
        if (age[i] >= FUEL_DURATION_S / fuel[i]) mark(i, CELL.ASH);
      } else if (state[i] === CELL.WET) {
        age[i] += dt;
        if (age[i] >= STEAM_S) mark(i, wasBurning[i] ? CELL.ASH : CELL.UNBURNED);
      }
    }

    // Spread from the tick-start front (snapshot semantics: one CA step).
    for (const i of burningAtStart) {
      if (state[i] !== CELL.BURNING) continue;   // drowned by ageing above
      const c0 = i % cols, r0 = (i / cols) | 0;
      for (const [dc, dr, e, n] of NEIGHBORS) {
        const c = c0 + dc, r = r0 + dr;
        if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
        const j = r * cols + c;
        if (state[j] !== CELL.UNBURNED) continue;
        const w = Math.max(0.05, 1 + aniso * (e * windEast + n * windNorth));
        if (rng() < SPREAD_RATE * w * fuel[j] * dt) {
          state[j] = CELL.BURNING; age[j] = 0; changes.burning.push(j);
        }
      }
    }
    return getState();
  }

  // ---- observation ------------------------------------------------------------
  function getState() {
    let burning = 0, ash = 0, wet = 0, unburned = 0, openFront = 0, knocked = 0;
    let hash = 0x811c9dc5;
    for (let i = 0; i < state.length; i++) {
      const s = state[i];
      if (s === CELL.BURNING) burning++;
      else if (s === CELL.ASH) ash++;
      else if (s === CELL.WET) { wet++; if (wasBurning[i]) knocked++; }
      else if (s === CELL.UNBURNED) unburned++;
      hash ^= s; hash = Math.imul(hash, 0x01000193);
    }
    for (const i of frontIndices()) {
      const c0 = i % cols, r0 = (i / cols) | 0;
      let open = false;
      for (const [dc, dr] of NEIGHBORS) {
        const c = c0 + dc, r = r0 + dr;
        if (c >= 0 && c < cols && r >= 0 && r < rows && state[r * cols + c] === CELL.UNBURNED) { open = true; break; }
      }
      if (open) openFront++;
    }
    const cellHa = (cellSizeM * cellSizeM) / 10000;
    return {
      time: t,
      phase: burning > 0 ? 'spreading' : ash + wet > 0 ? 'extinguished' : 'dormant',
      counts: { burning, ash, wet, unburned },
      burnedAreaHa: (ash + knocked) * cellHa,  // ash + still-steaming knocked-down
      containedFrac: burning > 0 ? 1 - openFront / burning : 1,
      gridHash: hash >>> 0,
    };
  }

  function frontIndices() {
    const out = [];
    for (let i = 0; i < state.length; i++) if (state[i] === CELL.BURNING) out.push(i);
    return out;
  }

  /** Cells changed since the previous takeChanges(); renderer delta feed. */
  function takeChanges() {
    const out = changes;
    changes = { burning: [], ash: [], wet: [], unburned: [] };
    return out;
  }

  function gridInfo() {
    return {
      cols, rows, cellSizeM,
      lonMin, latMax,            // grid origin: north-west corner
      cellDegLon, cellDegLat,
      stateAt: (c, r) => state[r * cols + c],
      lonLatOf: (i) => [lonMin + ((i % cols) + 0.5) * cellDegLon, latMax - (((i / cols) | 0) + 0.5) * cellDegLat],
    };
  }

  function describe() {
    return {
      api: FIRE_SIM_API,
      machine: 'cellular-automaton wildfire',
      conventions: {
        grid: 'row 0 = north edge; index = row * cols + col',
        wind: 'toDeg = compass direction wind blows toward',
        states: { UNBURNED: 0, BURNING: 1, ASH: 2, WET: 3, NO_FUEL: 4 },
        determinism: 'seeded per-tick PRNG; same seed + commands => same gridHash',
      },
      limits: { spreadRatePerSec: SPREAD_RATE, fuelDurationS: FUEL_DURATION_S, steamS: STEAM_S },
      commands: ['ignite', 'dropWater', 'tick', 'getState', 'takeChanges', 'gridInfo', 'describe'],
    };
  }

  return { ignite, dropWater, tick, getState, takeChanges, gridInfo, describe, CELL };
}

export default createFireSim;
