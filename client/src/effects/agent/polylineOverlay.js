// effects/agent/polylineOverlay.js — E6.3 generic L2 primitive: polylines.
//
// Draws the scene model's `polylines` (order geometry — e.g. a drawn route or a
// boundary the package turned into an order) as Google-Maps Polylines in 2D and
// Cesium polyline entities in 3D. Data-driven and domain-agnostic: colour, width
// and dashing come from each polyline's package-supplied style. Keyed by id and
// reconciled each frame (add/update/remove) so a live-drawn order tracks the pen.

function dashPattern(Cesium, p) {
  if (!p.dashed) return undefined;
  return new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString(p.color || '#f59e0b'), dashLength: p.dashLength || 16 });
}

/** 2D: one Google Maps Polyline per descriptor, keyed by id. */
export function attachPolylineOverlay2d(mapsApi, map, model) {
  let removed = false;
  const byId = new Map();
  let raf = 0;

  function sync() {
    raf = requestAnimationFrame(sync);
    if (removed) return;
    const seen = new Set();
    for (const p of model.polylines) {
      const id = p.id ?? `${p.points.length}:${p.points[0].lon}:${p.points[0].lat}`;
      seen.add(id);
      const path = p.points.map((pt) => new mapsApi.LatLng(pt.lat, pt.lon));
      let line = byId.get(id);
      if (!line) {
        line = new mapsApi.Polyline({
          path,
          geodesic: true,
          strokeColor: p.color || '#f59e0b',
          strokeOpacity: p.opacity ?? 0.9,
          strokeWeight: p.width || 3,
          icons: p.dashed ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeWeight: p.width || 3 }, repeat: '12px' }] : undefined,
          map,
        });
        byId.set(id, line);
      } else {
        line.setPath(path);
        line.setOptions({ strokeColor: p.color || '#f59e0b', strokeWeight: p.width || 3, strokeOpacity: p.opacity ?? 0.9 });
      }
    }
    for (const [id, line] of byId) if (!seen.has(id)) { line.setMap(null); byId.delete(id); }
  }
  raf = requestAnimationFrame(sync);

  return {
    detach() {
      if (removed) return;
      removed = true;
      cancelAnimationFrame(raf);
      for (const line of byId.values()) line.setMap(null);
      byId.clear();
    },
  };
}

/** 3D: one Cesium polyline entity per descriptor, keyed by id. */
export function attachPolylineOverlay3d(viewer, model) {
  const Cesium = window.Cesium;
  let removed = false;
  const byId = new Map();
  let raf = 0;

  function flatPositions(p) {
    const arr = [];
    for (const pt of p.points) { arr.push(pt.lon, pt.lat, pt.alt || 0); }
    return Cesium.Cartesian3.fromDegreesArrayHeights(arr);
  }

  function sync() {
    raf = requestAnimationFrame(sync);
    if (removed) return;
    const seen = new Set();
    for (const p of model.polylines) {
      const id = p.id ?? `${p.points.length}:${p.points[0].lon}:${p.points[0].lat}`;
      seen.add(id);
      let e = byId.get(id);
      if (!e) {
        e = viewer.entities.add({
          polyline: {
            positions: flatPositions(p),
            width: p.width || 3,
            clampToGround: p.clampToGround !== false,
            material: dashPattern(Cesium, p) || Cesium.Color.fromCssColorString(p.color || '#f59e0b').withAlpha(p.opacity ?? 0.9),
          },
        });
        byId.set(id, e);
      } else {
        e.polyline.positions = flatPositions(p);
        e.polyline.width = p.width || 3;
      }
    }
    for (const [id, e] of byId) if (!seen.has(id)) { viewer.entities.remove(e); byId.delete(id); }
  }
  raf = requestAnimationFrame(sync);

  return {
    detach() {
      if (removed) return;
      removed = true;
      cancelAnimationFrame(raf);
      for (const e of byId.values()) viewer.entities.remove(e);
      byId.clear();
    },
  };
}
