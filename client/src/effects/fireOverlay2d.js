// fireOverlay2d.js — engine glue: renders a fireEffect onto a Google Maps
// (Plan view) map as a transparent canvas OverlayView.
//
// Layering inside the one canvas:
//   1. effect.scarCanvas stretched over the grid bounds (ash + wet raster);
//   2. pre-rendered flame sprites drawn per burning cell with per-frame
//      jitter (flicker), so thousands of cells stay cheap (drawImage, no
//      per-frame gradients).
// The canvas sits in overlayLayer with pointer-events: none — pens, clicks
// and map controls keep working exactly as before.

// One 64 px flame sprite, pre-rendered once: radial gradient + hot core.
let flameSprite = null;
function getFlameSprite() {
  if (flameSprite) return flameSprite;
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
  flameSprite = c;
  return c;
}

export function attachFireOverlay2d(mapsApi, map, effect) {
  let canvas = null;
  let ctx = null;
  let raf = 0;
  let removed = false;

  class FireOverlay extends mapsApi.OverlayView {
    onAdd() {
      canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.pointerEvents = 'none';   // clicks fall through to the map
      this.getPanes().overlayLayer.appendChild(canvas);
      ctx = canvas.getContext('2d');
    }
    draw() {
      positionCanvas(this.getProjection());
    }
    onRemove() {
      if (canvas) canvas.remove();
      canvas = null;
      ctx = null;
    }
  }

  function gridBounds() {
    const g = effect.grid;
    return {
      nw: new mapsApi.LatLng(g.latMax, g.lonMin),
      se: new mapsApi.LatLng(g.latMax - g.rows * g.cellDegLat, g.lonMin + g.cols * g.cellDegLon),
    };
  }

  function positionCanvas(projection) {
    if (!canvas || !effect.grid) return;
    const { nw, se } = gridBounds();
    const a = projection.fromLatLngToDivPixel(nw);
    const b = projection.fromLatLngToDivPixel(se);
    const w = Math.max(1, Math.round(b.x - a.x));
    const h = Math.max(1, Math.round(b.y - a.y));
    canvas.style.left = Math.round(a.x) + 'px';
    canvas.style.top = Math.round(a.y) + 'px';
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function renderFrame(now) {
    raf = requestAnimationFrame(renderFrame);
    if (!ctx || !effect.grid || !effect.scarCanvas) return;
    const g = effect.grid;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;        // soften the scar edges a little
    ctx.drawImage(effect.scarCanvas, 0, 0, canvas.width, canvas.height);
    const cw = canvas.width / g.cols;
    const ch = canvas.height / g.rows;
    if (cw <= 0 || ch <= 0) return;
    const sprite = getFlameSprite();
    for (const i of effect.burningCells) {
      const c = i % g.cols;
      const r = (i / g.cols) | 0;
      // Deterministic per-cell phase + time-based flicker.
      const f = 0.8 + 0.25 * Math.sin(now / 90 + (i % 97));
      const w = cw * 2.2 * f;
      const h = ch * 2.6 * f;
      ctx.drawImage(sprite, (c + 0.5) * cw - w / 2, (r + 0.5) * ch - h * 0.62, w, h);
    }
  }

  const overlay = new FireOverlay();
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
