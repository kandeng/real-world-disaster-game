// effects/agent/cellGridOverlay.js — E6.3 generic L2 primitive: cell grids.
//
// Generalizes today's fire scar canvas into a domain-agnostic raster: the
// package hands the scene model a grid geometry, a per-cell value array and a
// colorOf(value)->cssColor function; this paints one grid-resolution offscreen
// canvas and stretches it over the grid bounds — a transparent Google-Maps
// OverlayView in 2D, a ground-classified rectangle with an image material in 3D.
// The engine names no domain: what a cell VALUE means and what COLOUR it gets is
// entirely the package's. Repaint is throttled on the model's cellVersion.

import { gridBoundsDeg } from './sceneModel.js';

const REPAINT_MS = 200;

/** Paint the grid-resolution raster from the model's current cell grid. */
function paintRaster(raster, rctx, cellGrid) {
  const { grid, values, colorOf } = cellGrid;
  if (raster.width !== grid.cols || raster.height !== grid.rows) {
    raster.width = grid.cols; raster.height = grid.rows;
  }
  rctx.clearRect(0, 0, grid.cols, grid.rows);
  if (!values || typeof colorOf !== 'function') return;
  for (let i = 0; i < grid.cols * grid.rows; i++) {
    const v = values[i];
    if (v == null) continue;
    const css = colorOf(v, i);
    if (!css) continue;
    const c = i % grid.cols;
    const r = (i / grid.cols) | 0;
    rctx.fillStyle = css;
    rctx.fillRect(c, r, 1, 1);
  }
}

/** 2D: canvas OverlayView stretched over the grid bounds. */
export function attachCellGridOverlay2d(mapsApi, map, model) {
  let canvas = null, ctx = null, raf = 0, removed = false;
  const raster = document.createElement('canvas');
  const rctx = raster.getContext('2d');
  let lastVersion = -1, lastMs = 0;

  class CellOverlay extends mapsApi.OverlayView {
    onAdd() {
      canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';
      this.getPanes().overlayLayer.appendChild(canvas);
      ctx = canvas.getContext('2d');
    }
    draw() { position(this.getProjection()); }
    onRemove() { if (canvas) canvas.remove(); canvas = null; ctx = null; }
  }

  function position(projection) {
    const cg = model.cellGrid;
    if (!canvas || !cg) return;
    const b = gridBoundsDeg(cg.grid);
    if (!b) return;
    const a = projection.fromLatLngToDivPixel(new mapsApi.LatLng(b.north, b.west));
    const z = projection.fromLatLngToDivPixel(new mapsApi.LatLng(b.south, b.east));
    const w = Math.max(1, Math.round(z.x - a.x));
    const h = Math.max(1, Math.round(z.y - a.y));
    canvas.style.left = Math.round(a.x) + 'px';
    canvas.style.top = Math.round(a.y) + 'px';
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function renderFrame(now) {
    raf = requestAnimationFrame(renderFrame);
    const cg = model.cellGrid;
    if (!ctx || !canvas || !cg) return;
    if (cg.colorOf && (model.cellVersion !== lastVersion) && (now - lastMs >= REPAINT_MS)) {
      lastVersion = model.cellVersion; lastMs = now;
      paintRaster(raster, rctx, cg);
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (raster.width > 0 && raster.height > 0) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(raster, 0, 0, canvas.width, canvas.height);
    }
  }

  const overlay = new CellOverlay();
  overlay.setMap(map);
  raf = requestAnimationFrame(renderFrame);

  return {
    detach() {
      if (removed) return;
      removed = true;
      cancelAnimationFrame(raf);
      overlay.setMap(null);
    },
  };
}

/** 3D: one ground-classified rectangle whose material is the grid raster. */
export function attachCellGridOverlay3d(viewer, model) {
  const Cesium = window.Cesium;
  const scene = viewer.scene;
  let removed = false, raf = 0;
  const raster = document.createElement('canvas');
  const rctx = raster.getContext('2d');
  let entity = null, lastVersion = -1, lastMs = 0;
  const supported = (() => { try { return Cesium.GroundPrimitive.isSupported(scene); } catch { return false; } })();

  function renderFrame(now) {
    raf = requestAnimationFrame(renderFrame);
    if (removed) return;
    const cg = model.cellGrid;
    if (!supported || !cg || !cg.colorOf) return;
    if (model.cellVersion === lastVersion) return;
    if (now - lastMs < REPAINT_MS) return;
    lastMs = now; lastVersion = model.cellVersion;
    paintRaster(raster, rctx, cg);
    const b = gridBoundsDeg(cg.grid);
    if (!b) return;
    const rect = Cesium.Rectangle.fromDegrees(b.west, b.south, b.east, b.north);
    if (!entity) {
      entity = viewer.entities.add({
        rectangle: {
          coordinates: rect,
          material: new Cesium.ImageMaterialProperty({ image: raster, transparent: true }),
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
    } else {
      entity.rectangle.coordinates = rect;
      entity.rectangle.material = new Cesium.ImageMaterialProperty({ image: raster, transparent: true });
    }
  }
  raf = requestAnimationFrame(renderFrame);

  return {
    detach() {
      if (removed) return;
      removed = true;
      cancelAnimationFrame(raf);
      if (entity) viewer.entities.remove(entity);
      entity = null;
    },
  };
}
