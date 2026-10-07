// effects/agent/sceneModel.js — E6.3: the PURE render model behind the generic
// L2 primitives (markerOverlay / modelOverlay / polylineOverlay / cellGridOverlay).
//
// This module holds NO browser APIs. It is the deterministic bridge between the
// core worker's batched render feed (agents.state snapshots + agents.event
// effects) and the browser glue overlays that actually paint. The glue reads
// these plain descriptors every frame; all the LOD-capping, archetype→style
// resolution and cell geometry live HERE so they are headless-testable and
// identical in 2d and 3d.
//
// Domain-agnostic by construction: the engine never names a domain. WHICH
// archetype draws as a model (a GLB) vs a flat marker, its colour/icon/mesh URL
// and scale, are PACKAGE-DECLARED styles handed in via setStyles(). An unknown
// archetype degrades to the fallback style (degrade never break).
//
// Feed contract (all inputs are plain JSON from the protocol):
//   setState(snapshot)            -> { t, agents:[{id, archetype, alive, pose, status}] }
//   handleEvent(event)            -> { kind:'effect', effect, lon, lat, params, t } (transient)
//   setStyles(styles)              -> { [archetype]: { kind?, meshUrl?, avatarUrl?, displayName?, avatarKind?, icon?, color?, scale?, modelScale? } }
//   setPolylines(list)            -> [{ id, points:[{lon,lat}], color?, width?, dashed? }]
//   setCellGrid(grid, values, colorOf) -> grid geometry + per-cell values + a value->rgba fn

/** Deterministic LOD subsample: keep every stride-th entry so `list` fits `max`. */
export function subsampleLOD(list, max) {
  const n = list.length;
  if (!Number.isFinite(max) || max <= 0 || n <= max) return list.slice();
  const stride = Math.ceil(n / max);
  const out = [];
  for (let i = 0; i < n; i++) if (i % stride === 0) out.push(list[i]);
  return out;
}

/**
 * Resolve the draw style for an archetype from the package-declared table.
 * Falls back to a neutral marker so an unknown/undeclared archetype still draws.
 * The spread carries EVERY package-declared field through untouched — including
 * `avatarUrl` / `displayName` / `avatarKind` — so the overlays can paint the
 * package avatar without this module naming any domain.
 */
export function resolveStyle(archetype, styles, fallback) {
  const base = fallback || DEFAULT_STYLE;
  const s = (styles && archetype != null && styles[archetype]) || null;
  if (!s) return base;
  return { ...base, ...s };
}

/** A style draws as a 3D model iff it declares a mesh URL (or kind:'model'). */
export function isModelStyle(style) {
  return !!style && (style.kind === 'model' || typeof style.meshUrl === 'string');
}

export const DEFAULT_STYLE = Object.freeze({
  kind: 'marker',
  color: '#3b82f6',
  scale: 1,
  radiusPx: 7,
});

/** Grid bounds in degrees: { west, south, east, north } from a cell-grid spec. */
export function gridBoundsDeg(grid) {
  if (!grid) return null;
  const west = grid.lonMin;
  const north = grid.latMax;
  const east = grid.lonMin + grid.cols * grid.cellDegLon;
  const south = grid.latMax - grid.rows * grid.cellDegLat;
  return { west, south, east, north };
}

/** Centre lon/lat of a linear cell index (row-major, north-west origin). */
export function cellLonLat(grid, index) {
  const c = index % grid.cols;
  const r = (index / grid.cols) | 0;
  return {
    lon: grid.lonMin + (c + 0.5) * grid.cellDegLon,
    lat: grid.latMax - (r + 0.5) * grid.cellDegLat,
  };
}

/**
 * createAgentSceneModel(options)
 *   options: { maxMarkers=400, maxModels=200, styles={}, fallback?, cellColorOf? }
 * Returns a plain object the glue overlays read each frame.
 */
export function createAgentSceneModel(options = {}) {
  const maxMarkers = Number.isFinite(options.maxMarkers) ? options.maxMarkers : 400;
  const maxModels = Number.isFinite(options.maxModels) ? options.maxModels : 200;
  let styles = options.styles && typeof options.styles === 'object' ? options.styles : {};
  const fallback = options.fallback || DEFAULT_STYLE;

  let t = 0;
  let agents = [];              // raw alive snapshots with a pose
  let markers = [];             // LOD-capped flat-marker descriptors
  let models = [];              // LOD-capped model descriptors
  let polylines = [];           // order geometry
  let cellGrid = null;          // { grid, values, colorOf }
  let cellVersion = 0;          // bumped whenever cells change (glue throttles on it)
  const transients = [];        // short-lived spawnEffect pings

  function rebuild() {
    const markerList = [];
    const modelList = [];
    for (const a of agents) {
      const style = resolveStyle(a.archetype, styles, fallback);
      const d = {
        id: a.id,
        archetype: a.archetype,
        lon: a.pose.lon,
        lat: a.pose.lat,
        alt: a.pose.alt ?? 0,
        headingDeg: a.pose.headingDeg ?? 0,
        status: a.status ?? null,
        style,
      };
      if (isModelStyle(style)) modelList.push(d);
      else markerList.push(d);
    }
    markers = subsampleLOD(markerList, maxMarkers);
    models = subsampleLOD(modelList, maxModels);
  }

  return {
    // ---- inputs (fed by the host relay from protocol messages) ----
    setState(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.agents)) return;
      t = Number(snapshot.t) || 0;
      agents = snapshot.agents.filter((a) => a && a.alive !== false && a.pose
        && Number.isFinite(a.pose.lon) && Number.isFinite(a.pose.lat));
      rebuild();
    },
    setStyles(next) {
      styles = next && typeof next === 'object' ? next : {};
      rebuild();
    },
    handleEvent(event) {
      if (!event || event.kind !== 'effect') return;
      if (!Number.isFinite(event.lon) || !Number.isFinite(event.lat)) return;
      transients.push({
        id: `${event.by || 'fx'}:${event.t}:${transients.length}`,
        effect: event.effect ?? null,
        lon: event.lon,
        lat: event.lat,
        params: event.params ?? null,
        bornAt: t,
        by: event.by ?? null,
      });
    },
    setPolylines(list) {
      polylines = Array.isArray(list)
        ? list.filter((p) => p && Array.isArray(p.points) && p.points.length >= 2)
        : [];
    },
    setCellGrid(grid, values, colorOf) {
      if (!grid || !Number.isFinite(grid.cols) || !Number.isFinite(grid.rows)) { cellGrid = null; return; }
      cellGrid = { grid, values: values || null, colorOf: typeof colorOf === 'function' ? colorOf : (options.cellColorOf || null) };
      cellVersion++;
    },
    /** Drop transients older than ttl seconds (sim time). */
    pruneTransients(ttl = 4) {
      for (let i = transients.length - 1; i >= 0; i--) if (t - transients[i].bornAt > ttl) transients.splice(i, 1);
    },
    clear() {
      agents = []; markers = []; models = []; polylines = []; cellGrid = null; transients.length = 0; t = 0;
    },

    // ---- outputs (read by the glue overlays each frame) ----
    get t() { return t; },
    get markers() { return markers; },
    get models() { return models; },
    get polylines() { return polylines; },
    get transients() { return transients; },
    get cellGrid() { return cellGrid; },
    get cellVersion() { return cellVersion; },
    get agentCount() { return agents.length; },
    get counts() { return { markers: markers.length, models: models.length, polylines: polylines.length, transients: transients.length }; },
  };
}
