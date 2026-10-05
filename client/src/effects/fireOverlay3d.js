// fireOverlay3d.js — engine glue (step 4): renders a fireEffect onto the
// shared Cesium viewer (Steer 3D / FPV view). Counterpart of fireOverlay2d.js;
// both consume the SAME effect state fed by the fire agent worker's protocol
// messages, so the planner (2D grid-artificial) and the vehicle (3D
// photoreal-ish) always see one fire.
//
// Layering:
//   1. burn scar — one ground-classified rectangle over the grid bounds whose
//      material is the effect's scar canvas (ash + wet raster), refreshed
//      (throttled) whenever the effect version moves;
//   2. flame billboards — one screen-aligned sprite per burning cell, clamped
//      to ground/tiles, per-frame flicker (scale + rotation jitter);
//   3. smoke billboards — larger translucent grey puffs on a subset of the
//      flame cells, slow billow pulse.
//
// LOD caps: with thousands of burning cells the billboard sets are
// deterministically subsampled (every k-th cell) to MAX_FLAMES / MAX_SMOKE;
// the scar rectangle stays exact regardless (it is one primitive).
//
// Package code never sees any of this: only DATA commands reach the effect;
// only this engine module touches Cesium.

const MAX_FLAMES = 600;
const MAX_SMOKE = 300;
const SCAR_REFRESH_MS = 250;
const FLAME_SCALE = 1.2;      // 64 px sprite -> ~77 px tall flame
const SMOKE_SCALE = 2.2;
const SMOKE_ALPHA = 0.26;

let flameImage = null;
let smokeImage = null;

function getFlameImage() {
  if (flameImage) return flameImage;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 36, 2, 32, 36, 30);
  g.addColorStop(0, 'rgba(255, 236, 140, 0.95)');
  g.addColorStop(0.35, 'rgba(255, 140, 26, 0.85)');
  g.addColorStop(0.75, 'rgba(200, 60, 10, 0.35)');
  g.addColorStop(1, 'rgba(120, 30, 0, 0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  flameImage = c;
  return c;
}

function getSmokeImage() {
  if (smokeImage) return smokeImage;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 4, 32, 32, 30);
  g.addColorStop(0, 'rgba(120, 118, 114, 0.55)');
  g.addColorStop(0.6, 'rgba(80, 78, 76, 0.3)');
  g.addColorStop(1, 'rgba(60, 58, 56, 0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  smokeImage = c;
  return c;
}

/**
 * @param viewer  the shared Cesium viewer (window.cesiumViewer)
 * @param effect  a fireEffect instance (engine-side state fed by protocol)
 * @returns {{ detach(): void }}
 */
export function attachFireOverlay3d(viewer, effect) {
  const Cesium = window.Cesium;
  const scene = viewer.scene;
  let removed = false;
  let raf = 0;

  const flames = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  const smokes = scene.primitives.add(new Cesium.BillboardCollection({ scene }));

  let scarEntity = null;
  let scarVersion = -1;
  let scarLastMs = 0;
  const scarSupported = (() => {
    try { return Cesium.GroundPrimitive.isSupported(scene); } catch { return false; }
  })();

  const cells = new Map();          // burning cell index -> { fb, sb|null, phase }
  let lastVersion = -1;

  function cellLonLat(i) {
    const g = effect.grid;
    const c = i % g.cols;
    const r = (i / g.cols) | 0;
    return [g.lonMin + (c + 0.5) * g.cellDegLon, g.latMax - (r + 0.5) * g.cellDegLat];
  }

  function addCell(i) {
    const [lon, lat] = cellLonLat(i);
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat);
    const phase = (i % 97) * 0.37;
    const fb = flames.add({
      position: pos,
      image: getFlameImage(),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      scale: FLAME_SCALE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      translucencyByDistance: new Cesium.NearFarScalar(1e2, 1.0, 1e5, 0.35),
    });
    let sb = null;
    if (smokes.length < MAX_SMOKE && i % 2 === 0) {
      sb = smokes.add({
        position: pos,
        image: getSmokeImage(),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        scale: SMOKE_SCALE,
        color: new Cesium.Color(1, 1, 1, SMOKE_ALPHA),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    cells.set(i, { fb, sb, phase });
  }

  function removeCell(i) {
    const e = cells.get(i);
    if (!e) return;
    flames.remove(e.fb);
    if (e.sb) smokes.remove(e.sb);
    cells.delete(i);
  }

  function syncMembership() {
    const burning = Array.from(effect.burningCells);
    // Deterministic LOD subsample: every stride-th burning cell keeps a flame.
    const stride = Math.max(1, Math.ceil(burning.length / MAX_FLAMES));
    const want = new Set();
    for (let k = 0; k < burning.length; k++) if (k % stride === 0) want.add(burning[k]);
    for (const i of cells.keys()) if (!want.has(i)) removeCell(i);
    for (const i of want) if (!cells.has(i)) addCell(i);
  }

  function syncScar(now) {
    if (!scarSupported || !effect.grid || !effect.scarCanvas) return;
    if (effect.version === scarVersion) return;
    if (now - scarLastMs < SCAR_REFRESH_MS) return;
    scarLastMs = now;
    scarVersion = effect.version;
    const g = effect.grid;
    const rect = Cesium.Rectangle.fromDegrees(
      g.lonMin,
      g.latMax - g.rows * g.cellDegLat,
      g.lonMin + g.cols * g.cellDegLon,
      g.latMax
    );
    if (!scarEntity) {
      scarEntity = viewer.entities.add({
        rectangle: {
          coordinates: rect,
          material: new Cesium.ImageMaterialProperty({ image: effect.scarCanvas, transparent: true }),
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
    } else {
      // Rebuild the material property so Cesium re-uploads the mutated canvas.
      scarEntity.rectangle.coordinates = rect;
      scarEntity.rectangle.material = new Cesium.ImageMaterialProperty({ image: effect.scarCanvas, transparent: true });
    }
  }

  function frame(now) {
    if (removed) return;
    raf = requestAnimationFrame(frame);
    if (!effect.grid) return;
    if (effect.version !== lastVersion) {
      lastVersion = effect.version;
      syncMembership();
      syncScar(now);
    }
    // Per-frame flicker: cheap uniform writes only, no geometry churn.
    const t = now;
    for (const { fb, sb, phase } of cells.values()) {
      const f = 0.85 + 0.22 * Math.sin(t * 0.006 + phase) + 0.08 * Math.sin(t * 0.017 + phase * 3);
      fb.scale = FLAME_SCALE * f;
      fb.rotation = 0.06 * Math.sin(t * 0.004 + phase);
      if (sb) {
        const s = SMOKE_SCALE * (1 + 0.18 * Math.sin(t * 0.0018 + phase * 2));
        sb.scale = s;
      }
    }
  }
  raf = requestAnimationFrame(frame);

  return {
    detach() {
      if (removed) return;
      removed = true;
      cancelAnimationFrame(raf);
      scene.primitives.remove(flames);
      scene.primitives.remove(smokes);
      if (scarEntity) viewer.entities.remove(scarEntity);
      cells.clear();
      scarEntity = null;
    },
  };
}
