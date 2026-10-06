// games/demo-wildfire/render/bindings.js — the package's L2 RENDER BINDINGS.
//
// Pure content, dependency-free ESM: runs identically in the core Web Worker and
// in plain Node, and touches NO browser API (the one rule). This module declares
// HOW the package's archetypes and environment cells are drawn, by referencing
// the engine's generic L2 primitives BY NAME (`engine:modelOverlay`,
// `engine:markerOverlay`, `engine:cellGridOverlay`). The engine resolves a name
// to browser code; this file never imports it.
//
// The host relay (E6.9) reads createRenderBindings() and feeds the result into
// the generic scene model:
//     const b = createRenderBindings();
//     model.setStyles(b.styles);                       // archetype -> marker/model
//     model.setCellGrid(grid, values, b.cellColorOf);  // environment raster
// Because the styles are PACKAGE-DECLARED, the engine stays domain-agnostic:
// adding a dry-ice drone or dropping the tank edits only this file (and the
// roster) — never client/src/engine or client/src/workers. That is the litmus.

// The environment cell states, mirrored from the fire sim (assets/fire/fire_sim.js
// CELL). Kept as a local legend so this module stays dependency-free; the values
// are the contract between the sim and its colour ramp.
export const CELL = Object.freeze({ UNBURNED: 0, BURNING: 1, ASH: 2, WET: 3, NO_FUEL: 4 });

/**
 * cellColorOf(value) -> a CSS colour, or null to leave the cell transparent.
 * The fire palette: unburned ground shows nothing, the active front burns hot
 * orange, the burn scar is near-black, soaked ground is a dark blue-grey, and
 * non-fuel terrain (the bay) is a faint slate so it reads as "cannot burn".
 */
export function cellColorOf(value) {
  switch (value) {
    case CELL.BURNING: return 'rgba(255, 140, 26, 0.85)';
    case CELL.ASH:     return 'rgba(20, 19, 18, 0.82)';
    case CELL.WET:     return 'rgba(38, 54, 74, 0.60)';
    case CELL.NO_FUEL: return 'rgba(120, 120, 120, 0.12)';
    case CELL.UNBURNED:
    default:           return null;
  }
}

// archetype -> the engine primitive (BY NAME) + the style params the generic
// scene model understands (kind, meshUrl, color, scale, modelScale, icon, ...).
// A binding with kind:'model' (or a meshUrl) draws as a 3D GLB; else a flat marker.
export const RENDER_BINDINGS = Object.freeze({
  // Both drone variants share the same airframe mesh; the dry-ice drone is tinted
  // a cold white so the two suppression roles read apart at a glance.
  waterDrone: {
    primitive: 'engine:modelOverlay',
    kind: 'model',
    meshUrl: 'assets/drone/drone_dji_air3.glb',
    modelScale: 0.1,            // host mm->m factor from assets/drone/drone.json
    color: '#38bdf8',
  },
  dryIceDrone: {
    primitive: 'engine:modelOverlay',
    kind: 'model',
    meshUrl: 'assets/drone/drone_dji_air3.glb',
    modelScale: 0.1,
    color: '#e2e8f0',
  },
  // The commander (human) and staff (VLM) are PACKAGE characters, not entities in
  // the world: they draw as flat markers anchored at their command post.
  commander: {
    primitive: 'engine:markerOverlay',
    kind: 'marker',
    color: '#f59e0b',
    icon: 'commander',
    radiusPx: 9,
  },
  staff: {
    primitive: 'engine:markerOverlay',
    kind: 'marker',
    color: '#a78bfa',
    icon: 'staff',
    radiusPx: 8,
  },
});

// The environment raster binding: which primitive paints the cell grid + the
// value->colour ramp above.
export const CELL_BINDING = Object.freeze({ primitive: 'engine:cellGridOverlay', colorOf: cellColorOf });

// The neutral style an UNKNOWN archetype degrades to (degrade never break): the
// engine's scene model merges this under any per-archetype binding.
export const FALLBACK_STYLE = Object.freeze({ kind: 'marker', color: '#9ca3af', radiusPx: 6, scale: 1 });

/**
 * createRenderBindings() -> the bundle the host relay feeds the scene model:
 *   { styles, cellColorOf, fallback, cell, bindings }
 * `styles` is the archetype -> style table sceneModel.setStyles() consumes.
 */
export function createRenderBindings() {
  const styles = {};
  for (const archetype of Object.keys(RENDER_BINDINGS)) styles[archetype] = RENDER_BINDINGS[archetype];
  return { styles, cellColorOf, fallback: FALLBACK_STYLE, cell: CELL_BINDING, bindings: RENDER_BINDINGS };
}

export default createRenderBindings;
