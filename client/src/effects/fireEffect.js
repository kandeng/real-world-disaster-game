// fireEffect.js — engine-side first-party effect catalog entry: 'fire'.
//
// Architecture rule honoured here: game packages / agents NEVER touch pixels,
// canvases or map primitives. They send DATA commands over a tiny protocol;
// this module (engine, first-party) owns the rasterization and exposes the
// results (scar canvas + live burning set) to map-specific glue layers
// (fireOverlay2d.js today, a Cesium adapter later).
//
// Protocol (handleCommand):
//   { type: 'fire.setGrid', grid: { cols, rows, lonMin, latMax, cellDegLon, cellDegLat } }
//       (Re)initialise the effect for one simulation grid. Row 0 = north edge,
//       index = row * cols + col — same convention as fire_sim.js gridInfo().
//   { type: 'fire.delta', burning: [i], ash: [i], wet: [i], unburned: [i] }
//       Incremental cell-state update (the sim's takeChanges() payload).
//   { type: 'fire.clear' }
//       Forget everything (session end).
//
// Visual contract:
//   • ASH  -> opaque-ish black pixel in the scar canvas (the burn scar).
//   • WET  -> dark blue-grey pixel (soaked ground / steam phase).
//   • BURNING -> transparent in the scar canvas; the cell joins burningCells
//     and the glue layer draws flickering flame sprites live on top.
//   • UNBURNED / NO_FUEL -> transparent.

export const FIRE_EFFECT_PROTOCOL = 1;

const S = { UNBURNED: 0, BURNING: 1, ASH: 2, WET: 3 };

export function createFireEffect() {
  let grid = null;
  let state = null;
  let scar = null;        // grid-resolution canvas: ash + wet raster
  let scarCtx = null;
  let version = 0;        // bumped on every accepted command; glue layers watch it
  const burning = new Set();

  function setGrid(g) {
    grid = { ...g };
    state = new Uint8Array(g.cols * g.rows);
    burning.clear();
    scar = document.createElement('canvas');
    scar.width = g.cols;
    scar.height = g.rows;
    scarCtx = scar.getContext('2d');
    scarCtx.clearRect(0, 0, g.cols, g.rows);
    version++;
  }

  function paint(i, mode) {
    const c = i % grid.cols;
    const r = (i / grid.cols) | 0;
    scarCtx.clearRect(c, r, 1, 1);
    if (mode === 'ash') {
      const n = (i * 40503) % 14;             // per-cell tone jitter: charred texture
      scarCtx.fillStyle = `rgba(${14 + n}, ${13 + n}, ${12 + n}, 0.82)`;
      scarCtx.fillRect(c, r, 1, 1);
    } else if (mode === 'wet') {
      scarCtx.fillStyle = 'rgba(38, 54, 74, 0.6)';
      scarCtx.fillRect(c, r, 1, 1);
    }
  }

  function applyDelta(d) {
    if (!grid) return;
    for (const i of d.unburned || []) { state[i] = S.UNBURNED; burning.delete(i); paint(i, 'none'); }
    for (const i of d.wet || []) { state[i] = S.WET; burning.delete(i); paint(i, 'wet'); }
    for (const i of d.ash || []) { state[i] = S.ASH; burning.delete(i); paint(i, 'ash'); }
    for (const i of d.burning || []) { state[i] = S.BURNING; burning.add(i); paint(i, 'none'); }
    version++;
  }

  function clear() {
    grid = null; state = null; scar = null; scarCtx = null;
    burning.clear();
    version++;
  }

  function handleCommand(cmd) {
    if (!cmd || typeof cmd.type !== 'string') return false;
    if (cmd.type === 'fire.setGrid') { setGrid(cmd.grid); return true; }
    if (cmd.type === 'fire.delta') { applyDelta(cmd); return true; }
    if (cmd.type === 'fire.clear') { clear(); return true; }
    return false;
  }

  return {
    handleCommand,
    get grid() { return grid; },
    get scarCanvas() { return scar; },
    get burningCells() { return burning; },
    get version() { return version; },
  };
}
