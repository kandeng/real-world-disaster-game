// effects/agent/markerOverlay.js — E6.3 generic L2 primitive: flat markers.
//
// Draws the scene model's `markers` (agents whose package style is a flat dot
// or an avatar badge, not a GLB) on both surfaces: a transparent Google-Maps
// canvas OverlayView (Plan/2D) and a Cesium PointPrimitiveCollection (Steer/3D).
// Purely data-driven — when a package declares `avatarUrl` the 2D marker paints
// that image as a circular badge; otherwise it falls back to a coloured dot. The
// colours/sizes come from package-declared styles; the engine names no domain.
// LOD is already applied upstream in the scene model, so this just paints what
// it is given. pointer-events:none keeps pens/clicks working.

/** 2D: canvas OverlayView painting an avatar badge (or dot) per marker. */
export function attachMarkerOverlay2d(mapsApi, map, model) {
  let canvas = null;
  let ctx = null;
  let raf = 0;
  let removed = false;
  const imgs = new Map();       // avatar URL -> { img, ready }

  /** Lazily load + cache an avatar image (mirrors modelOverlay's icon()). */
  function icon(url) {
    let e = imgs.get(url);
    if (!e) {
      const img = new Image();
      e = { img, ready: false };
      img.onload = () => { e.ready = true; };
      img.src = url;
      imgs.set(url, e);
    }
    return e;
  }

  class MarkerOverlay extends mapsApi.OverlayView {
    onAdd() {
      canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';
      this.getPanes().overlayLayer.appendChild(canvas);
      ctx = canvas.getContext('2d');
    }
    draw() {
      if (!canvas) return;
      const div = map.getDiv();
      const w = div.clientWidth, h = div.clientHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      canvas.style.left = '0px';
      canvas.style.top = '0px';
    }
    onRemove() {
      if (canvas) canvas.remove();
      canvas = null; ctx = null;
    }
  }

  function renderFrame() {
    raf = requestAnimationFrame(renderFrame);
    if (!ctx || !canvas) return;
    const proj = overlay.getProjection();
    if (!proj) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const m of model.markers) {
      const p = proj.fromLatLngToDivPixel(new mapsApi.LatLng(m.lat, m.lon));
      if (!p) continue;
      const scale = m.style.scale || 1;
      const url = m.style.avatarUrl;
      const e = url ? icon(url) : null;
      if (e && e.ready) {
        // Package-declared avatar: a circular badge (white disc + cover-fit glyph
        // + a colour ring that still identifies the archetype at a glance).
        const r = Math.max(9, (m.style.radiusPx || 7) * scale * 1.5);
        ctx.save();
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.clip();
        const iw = e.img.width || r * 2, ih = e.img.height || r * 2;
        const fit = Math.max((r * 2) / iw, (r * 2) / ih);
        const w = iw * fit, h = ih * fit;
        ctx.drawImage(e.img, p.x - w / 2, p.y - h / 2, w, h);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.lineWidth = m.style.borderWidth || 2;
        ctx.strokeStyle = m.style.borderColor || m.style.color || '#3b82f6';
        ctx.stroke();
        continue;
      }
      // Fallback: a plain coloured dot (no avatar declared / not loaded yet).
      const r = Math.max(2, (m.style.radiusPx || 7) * scale);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = m.style.color || '#3b82f6';
      ctx.fill();
      if (m.style.borderColor) { ctx.lineWidth = m.style.borderWidth || 1.5; ctx.strokeStyle = m.style.borderColor; ctx.stroke(); }
    }
  }

  const overlay = new MarkerOverlay();
  overlay.setMap(map);
  raf = requestAnimationFrame(renderFrame);

  return {
    detach() {
      if (removed) return;
      removed = true;
      cancelAnimationFrame(raf);
      overlay.setMap(null);
      imgs.clear();
    },
  };
}

/** 3D: one Cesium point primitive per marker, keyed by id (add/update/remove). */
export function attachMarkerOverlay3d(viewer, model) {
  const Cesium = window.Cesium;
  const scene = viewer.scene;
  let removed = false;
  const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const byId = new Map();       // id -> point primitive
  let raf = 0;

  function sync() {
    raf = requestAnimationFrame(sync);
    if (removed) return;
    const seen = new Set();
    for (const m of model.markers) {
      seen.add(m.id);
      const pos = Cesium.Cartesian3.fromDegrees(m.lon, m.lat, m.alt || 0);
      const color = Cesium.Color.fromCssColorString(m.style.color || '#3b82f6');
      const size = Math.max(3, (m.style.radiusPx || 7) * 2 * (m.style.scale || 1));
      let p = byId.get(m.id);
      if (!p) {
        p = points.add({ position: pos, color, pixelSize: size, disableDepthTestDistance: Number.POSITIVE_INFINITY });
        byId.set(m.id, p);
      } else {
        p.position = pos; p.color = color; p.pixelSize = size;
      }
    }
    for (const [id, p] of byId) if (!seen.has(id)) { points.remove(p); byId.delete(id); }
  }
  raf = requestAnimationFrame(sync);

  return {
    detach() {
      if (removed) return;
      removed = true;
      cancelAnimationFrame(raf);
      scene.primitives.remove(points);
      byId.clear();
    },
  };
}
