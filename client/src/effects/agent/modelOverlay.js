// effects/agent/modelOverlay.js — E6.3 generic L2 primitive: mesh models.
//
// Draws the scene model's `models` (agents whose PACKAGE style declares a GLB
// meshUrl) as oriented Cesium model entities in 3D, and as a rotated avatar
// (style.avatarUrl; falls back to style.icon, then a labelled dot) on the 2D
// canvas. The engine never names a domain: the mesh URL, avatar/icon, scale and
// colour are all package-declared. Entities are keyed by agent id and reused
// across frames (position/orientation updated in place) so hundreds stay cheap.

function headingToCesium(Cesium, lon, lat, alt, headingDeg) {
  const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(headingDeg || 0), 0, 0);
  const origin = Cesium.Cartesian3.fromDegrees(lon, lat, alt || 0);
  return Cesium.Transforms.headingPitchRollQuaternion(origin, hpr);
}

/** 3D: one Cesium model entity per model descriptor, keyed by id. */
export function attachModelOverlay3d(viewer, model) {
  const Cesium = window.Cesium;
  let removed = false;
  const byId = new Map();       // id -> entity
  let raf = 0;

  function sync() {
    raf = requestAnimationFrame(sync);
    if (removed) return;
    const seen = new Set();
    for (const m of model.models) {
      seen.add(m.id);
      const uri = m.style.meshUrl;
      if (!uri) continue;
      let e = byId.get(m.id);
      if (!e) {
        e = viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(m.lon, m.lat, m.alt || 0),
          orientation: headingToCesium(Cesium, m.lon, m.lat, m.alt, m.headingDeg),
          model: {
            uri,
            scale: m.style.modelScale || 1,
            minimumPixelSize: m.style.minimumPixelSize || 32,
            maximumScale: m.style.maximumScale || undefined,
            silhouetteColor: Cesium.Color.fromCssColorString(m.style.silhouetteColor || '#000000'),
            silhouetteSize: m.style.silhouetteSize || 0,
          },
        });
        byId.set(m.id, e);
      } else {
        e.position = Cesium.Cartesian3.fromDegrees(m.lon, m.lat, m.alt || 0);
        e.orientation = headingToCesium(Cesium, m.lon, m.lat, m.alt, m.headingDeg);
        if (e.model && e.model.uri !== uri) e.model.uri = uri;
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

/** 2D: canvas OverlayView painting a rotated avatar (or dot) per model. */
export function attachModelOverlay2d(mapsApi, map, model) {
  let canvas = null;
  let ctx = null;
  let raf = 0;
  let removed = false;
  const imgs = new Map();       // avatar/icon URL -> { img, ready }

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

  class ModelOverlay extends mapsApi.OverlayView {
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
      if (canvas.width !== div.clientWidth || canvas.height !== div.clientHeight) {
        canvas.width = div.clientWidth; canvas.height = div.clientHeight;
      }
    }
    onRemove() { if (canvas) canvas.remove(); canvas = null; ctx = null; }
  }

  function renderFrame() {
    raf = requestAnimationFrame(renderFrame);
    if (!ctx || !canvas) return;
    const proj = overlay.getProjection();
    if (!proj) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const m of model.models) {
      const p = proj.fromLatLngToDivPixel(new mapsApi.LatLng(m.lat, m.lon));
      if (!p) continue;
      const url = m.style.avatarUrl || m.style.icon;
      const e = url ? icon(url) : null;
      const s = m.style.scale || 1;
      if (e && e.ready) {
        // Cover-fit the avatar into a bounded, heading-rotated badge so any
        // source SVG natural size works (avatarUrl standardised over `icon`).
        const half = Math.max(9, (m.style.radiusPx || 12)) * s;
        const iw = e.img.width || half * 2, ih = e.img.height || half * 2;
        const fit = Math.max((half * 2) / iw, (half * 2) / ih);
        const w = iw * fit, h = ih * fit;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(((m.headingDeg || 0) * Math.PI) / 180);
        ctx.drawImage(e.img, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else {
        const r = Math.max(3, (m.style.radiusPx || 9) * s);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = m.style.color || '#22c55e';
        ctx.fill();
      }
    }
  }

  const overlay = new ModelOverlay();
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
